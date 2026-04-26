import { Command } from 'commander';
import { saveCredentials, peekIdentity } from './store.js';
import { AuthError, NetworkError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { c, icon } from '../output/color.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import {
  getEffectiveApiUrl,
  getEffectiveWorkosClientId,
} from '../config/env-profiles.js';
import { posthogAliasAndIdentify } from '../observability/posthog.js';

// --- Phase 122 bootstrap-code exchange DTO ---
// Mirrors backend/src/auth/bootstrap/dto/exchange-bootstrap.dto.ts (Wave 1
// locked contract). The CLI does not import from the backend — the DTO is
// re-declared here verbatim so drift is caught by integration tests.
interface ExchangeBootstrapResponseDto {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch SECONDS
  workspace: {
    id: string; // ws_<8> publicId
    name: string;
    workosOrganizationId: string;
  };
  user: {
    publicId: string; // usr_<8>
    email: string;
  };
}

// --- Types used by the post-login wizard ---
interface Workspace {
  id: string;
  name: string;
  role?: string;
  workosOrganizationId: string;
  slug?: string;
}

interface SandboxSessionLite {
  id: string;
  workspaceId?: string;
  phone: string | null;
  status: string;
  // Phase 126: consumed bind code persists on SandboxSession as `accessToken`
  // (the starter-kit WHATSAPP_ACCESS_TOKEN). See 126-CONTEXT.md §1 for the
  // rename rationale.
  accessToken: string;
  hmacSecret: string;
}

export interface WizardOpts {
  /** Skip sandbox session picker; use this phone (creates it if missing). */
  phone?: string;
  /** Non-interactive action selector (integration-test hook). */
  next?: 'sandbox' | 'channels' | 'exit';
  /** Emit a final JSON completion payload instead of human-friendly logs. */
  json?: boolean;
}

async function pollForTokens(opts: {
  clientId: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}): Promise<void> {
  const deadline = Date.now() + opts.expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.interval * 1000));

    const res = await fetch('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: opts.deviceCode,
        client_id: opts.clientId,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      saveCredentials({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      });
      // Phase 125 — alias machineId → workosSub once per (machine, user) and
      // emit cli_logged_in. Fail-open: a posthog hiccup must never block the
      // login UX. Pass email + name so the PostHog Person profile shows the
      // human identity for CLI events.
      const u = data.user ?? {};
      const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
      await posthogAliasAndIdentify({
        jwt: data.access_token,
        loginMethod: 'device',
        email: u.email,
        name: fullName.length > 0 ? fullName : undefined,
      });
      console.log(`\n${c.success(icon.success)} Logged in successfully\n`);
      return;
    }

    const err = await res.json().catch(() => ({}));
    if (err.error === 'authorization_pending') {
      continue;
    }
    if (err.error === 'slow_down') {
      opts.interval += 5;
      continue;
    }

    // Unexpected error
    throw new AuthError('Login failed: ' + (err.error_description ?? err.error ?? 'unknown error'));
  }

  throw new AuthError(`Login timed out. Try again: ${cliCommandPrefix()} login`);
}

/**
 * Post-login wizard. Directly dispatched (never via subprocess) after
 * pollForTokens succeeds.
 *
 * 1. Fetch workspaces → single silent-select OR multi-select picker.
 * 2. Persist active workspace + refresh JWT for picked org.
 * 3. Non-interactive "Next steps" guide (or honor --next/--phone/--json).
 *
 * The previous interactive "What next?" picker was removed because picking
 * "Start sandbox" created a fresh pending_activation session and immediately
 * tried to listen, which the backend rejects.
 */
export async function runWizard(opts: WizardOpts = {}): Promise<void> {
  const { apiClient, forceTokenRefresh } = await import('../api/client.js');
  const { writeWorkspaceConfig, readWorkspaceConfig } = await import('../commands/workspace.js');
  const { select } = await import('@inquirer/prompts');

  // Step 1 — workspace resolution.
  const workspaces = (await apiClient('/workspaces')) as Workspace[];

  if (workspaces.length === 0) {
    console.log(
      `${c.warn('!')} You aren't a member of any workspace yet. Run: ${c.dim(
        `${cliCommandPrefix()} workspace new <name>`,
      )}`,
    );
    return;
  }

  let activeWorkspaceId: string;
  let activeWorkspaceName: string;
  let activeWorkspaceOrg: string;

  // Honor an already-active workspace (from prior `workspace use` or an
  // integration-test seed). This keeps the wizard idempotent across repeat
  // logins — users don't re-pick on every `hookmyapp login`.
  const existing = readWorkspaceConfig();
  const preselected = existing.activeWorkspaceId
    ? workspaces.find((w) => w.id === existing.activeWorkspaceId)
    : undefined;

  if (preselected) {
    activeWorkspaceId = preselected.id;
    activeWorkspaceName = preselected.name;
    activeWorkspaceOrg = preselected.workosOrganizationId;
    console.log(
      `${c.success(icon.success)} Using workspace: ${c.dim(activeWorkspaceName)}`,
    );
  } else if (workspaces.length === 1) {
    const only = workspaces[0];
    activeWorkspaceId = only.id;
    activeWorkspaceName = only.name;
    activeWorkspaceOrg = only.workosOrganizationId;
    writeWorkspaceConfig({
      activeWorkspaceId,
      activeWorkspaceSlug: activeWorkspaceName,
    });
    console.log(
      `${c.success(icon.success)} Logged in to workspace: ${c.dim(activeWorkspaceName)}`,
    );
  } else {
    const chosen = (await select<Workspace>({
      message: 'Choose a workspace',
      choices: workspaces.map((w) => ({
        name: `${w.name}${w.role ? c.dim(` (${w.role})`) : ''}`,
        value: w,
      })),
    })) as Workspace;
    activeWorkspaceId = chosen.id;
    activeWorkspaceName = chosen.name;
    activeWorkspaceOrg = chosen.workosOrganizationId;
    writeWorkspaceConfig({
      activeWorkspaceId,
      activeWorkspaceSlug: activeWorkspaceName,
    });
  }

  // Refresh JWT so it carries the picked org's context (role + org_id
  // claims). Device-code grant issues a user-scoped token; without this
  // step, workspace-admin endpoints 403 even for actual admins.
  if (activeWorkspaceOrg) {
    try {
      await forceTokenRefresh(activeWorkspaceOrg);
    } catch {
      // non-fatal: next apiClient call will surface auth errors
    }
  }

  // Step 2 — non-interactive next steps.
  //
  // Explicit escape hatches (scripts / integration tests) take precedence.
  if (opts.next === 'sandbox') {
    await runSandboxFlow({ phone: opts.phone, json: opts.json });
    return;
  }
  if (opts.next === 'channels') {
    await runChannelsConnectFlow();
    return;
  }

  // --phone (without --next) preserves the legacy "auto-sandbox on phone"
  // behavior some scripts rely on.
  if (opts.phone) {
    await runSandboxFlow({ phone: opts.phone, json: opts.json });
    return;
  }

  // Default path: a printed next-steps guide. No interactive prompt.
  // When invoked via `npx` (npm >= 7 sets npm_command=exec), the bare
  // `hookmyapp` binary isn't on PATH, so cliCommandPrefix() returns
  // `'npx hookmyapp'` instead. Single source of truth in output/cli-self.ts.
  const cmd = cliCommandPrefix();
  const entries: ReadonlyArray<readonly [string, string]> = [
    ['sandbox start', 'create a sandbox session and get a WhatsApp test number'],
    ['channels connect', 'connect a real WhatsApp Business channel'],
    ['help', 'see all commands'],
  ];
  const col = cmd.length + 1 + Math.max(...entries.map(([s]) => s.length)) + 4;
  const nextSteps = entries.map(
    ([sub, desc]) => `${cmd} ${sub}`.padEnd(col) + `— ${desc}`,
  );

  if (opts.json) {
    // Structured payload for scripts. Keep the existing top-level shape
    // (ok/workspaceId/next) stable — only add nextSteps.
    process.stdout.write(
      JSON.stringify({
        ok: true,
        workspaceId: activeWorkspaceId,
        next: 'exit',
        nextSteps,
      }) + '\n',
    );
    return;
  }

  if (opts.next === 'exit') {
    // Silent exit for scripts that opt out of the human block.
    return;
  }

  // Human-readable next-steps block.
  console.log('\nNext steps');
  console.log('----------');
  for (const line of nextSteps) {
    console.log(`  ${line}`);
  }
  console.log('');
}

/**
 * Sandbox sub-flow. Invoked by the wizard when the user passes
 * `hookmyapp login --next sandbox` (or `--phone <e164>` without `--next`).
 *
 * Phase 126 bind-code model — session creation is phone-initiated (user
 * sends a bind code from their WhatsApp into the shared sandbox number),
 * NOT CLI-flag-initiated. The wizard therefore no longer offers a
 * "create from phone" path; that's what `hookmyapp sandbox start` does,
 * and we delegate to it directly.
 *
 * 0 sessions → runSandboxStart (prints bind code + QR + polls; on poll success,
 *              runSandboxListenFlow starts automatically because `--listen` is true).
 * 1 session  → direct listen (matches the "single active session" fast-path
 *              from before Phase 126 — preserved so repeated logins don't
 *              force the user through bind flow again).
 * N sessions → picker (no "+ Create new" — bind flow handles that; the
 *              picker is purely for choosing which ALREADY-bound phone to
 *              listen on).
 * --phone    → authoritative match on existing sessions. If present, listen.
 *              If not, surface a ValidationError pointing at sandbox start;
 *              the wizard does not try to bind a specific phone because
 *              binding is inbound-message-driven, not CLI-driven.
 */
export async function runSandboxFlow(
  opts: { phone?: string; json?: boolean } = {},
): Promise<void> {
  const { apiClient } = await import('../api/client.js');
  const { readWorkspaceConfig } = await import('../commands/workspace.js');
  const { select } = await import('@inquirer/prompts');

  const config = readWorkspaceConfig();
  const workspaceId = config.activeWorkspaceId;
  if (!workspaceId) {
    throw new ValidationError(
      `No active workspace. Run: ${cliCommandPrefix()} workspace use <name>`,
    );
  }

  const sessions = (await apiClient('/sandbox/sessions?active=true', {
    method: 'GET',
    workspaceId,
  })) as SandboxSessionLite[];

  // --phone is authoritative: match against existing active sessions only.
  // Phase 126 — we do NOT POST /sandbox/sessions here (endpoint deleted);
  // binding is phone-initiated via an inbound WhatsApp message matching
  // the user's bind code, which the dedicated `sandbox start` command
  // drives.
  if (opts.phone) {
    const normalized = opts.phone.replace(/^\+/, '');
    const match = sessions.find(
      (s) => s.phone && s.phone.replace(/^\+/, '') === normalized,
    );
    if (match) {
      await startListen(match, workspaceId, opts.json);
      return;
    }
    throw new ValidationError(
      `No active sandbox session for ${opts.phone}. Run ` +
        `\`${cliCommandPrefix()} sandbox start\` and bind your phone first.`,
    );
  }

  // --json mode cannot prompt; require an explicit --phone.
  if (opts.json) {
    throw new ValidationError(
      'In --json mode, pass --phone <e164> to select an existing sandbox session.',
    );
  }

  if (sessions.length === 0) {
    // No active sessions — delegate to the bind-code flow. runSandboxStart
    // prints the bind code + QR, polls, and (with --listen) chains into
    // runSandboxListenFlow so the final UX is identical to the legacy
    // "create + listen" single step.
    const { runSandboxStart } = await import('../commands/sandbox.js');
    await runSandboxStart({ listen: true, json: opts.json });
    return;
  }

  if (sessions.length === 1) {
    await startListen(sessions[0], workspaceId, opts.json);
    return;
  }

  // N sessions → picker over existing active sessions. No "+ Create new"
  // sentinel — binding is inbound-message-driven; if the user wants to
  // bind another phone they run `hookmyapp sandbox start` directly.
  const choice = (await select<SandboxSessionLite>({
    message: 'Select a sandbox session',
    choices: sessions.map((s) => ({
      name: `+${(s.phone ?? '').replace(/^\+/, '')} (${s.status})`,
      value: s,
    })),
  })) as SandboxSessionLite;

  await startListen(choice, workspaceId, opts.json);
}

async function startListen(
  session: SandboxSessionLite,
  workspaceId: string,
  _json?: boolean,
): Promise<void> {
  // IMPORTANT: direct function import — NEVER subprocess spawn.
  const { runSandboxListenFlow } = await import('../commands/sandbox-listen/index.js');
  const fullSession = {
    id: session.id,
    workspaceId: session.workspaceId ?? workspaceId,
    phone: session.phone,
    status: session.status,
    lastHeartbeatAt: null,
  };
  await runSandboxListenFlow(fullSession);
}

async function runChannelsConnectFlow(): Promise<void> {
  // Direct function import — never subprocess spawn. Lazy import breaks the
  // index.ts → commands/channels.ts → auth/login.ts cycle.
  const { runChannelsConnect } = await import('../commands/channels.js');
  await runChannelsConnect();
}

/**
 * Phase 122: bootstrap-code exchange branch. Invoked when the user (or their
 * AI) runs `hookmyapp login --code hma_boot_<32>`. Bypasses the WorkOS device
 * flow entirely — zero browser interaction, zero polling — then re-enters
 * runWizard so the rest of the CLI (active workspace, --phone/--next hooks,
 * JSON output shape) behaves identically to a browser login.
 *
 * Flow:
 *   1. peekIdentity() BEFORE overwrite — needed for the "was:" diff.
 *   2. POST /auth/bootstrap/exchange (unauthenticated @Public route).
 *   3. saveCredentials + writeWorkspaceConfig — same shape the device-flow
 *      wizard writes, so downstream api calls work unchanged.
 *   4. Print "Replaced previous session (was: ...)" if prior identity differs.
 *   5. Print "Logged in as ..." — stable contract the AI matches against.
 *   6. runWizard — preselected-workspace path short-circuits the picker.
 *
 * Errors flow through mapApiError → the CLI error hierarchy pins exit codes.
 */
export async function runBootstrapCodeExchange(
  code: string,
  opts: { phone?: string; next?: 'sandbox' | 'channels' | 'exit'; json?: boolean },
): Promise<void> {
  const { mapApiError, isNetworkFailure } = await import('../api/client.js');
  const { writeWorkspaceConfig } = await import('../commands/workspace.js');

  const prior = peekIdentity();

  const baseUrl = getEffectiveApiUrl();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/auth/bootstrap/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    if (isNetworkFailure(err)) throw new NetworkError();
    throw err;
  }
  if (!res.ok) throw await mapApiError(res);

  const data = (await res.json()) as ExchangeBootstrapResponseDto;

  saveCredentials({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt,
  });
  writeWorkspaceConfig({
    activeWorkspaceId: data.workspace.id,
    activeWorkspaceSlug: data.workspace.name,
  });

  // Phase 125 — alias machineId → workosSub once per (machine, user) and
  // emit cli_logged_in. workspace publicId is already on disk above so
  // baseline workspace_id resolves. Fail-open: posthog hiccup ≠ blocked login.
  // Pass email so the PostHog Person profile shows the human identity for CLI
  // events without requiring a frontend visit. The bootstrap-code response
  // shape only carries email, not first/last name.
  await posthogAliasAndIdentify({
    jwt: data.accessToken,
    loginMethod: 'code',
    email: data.user.email,
  });

  // NOTE: prior.workspaceSlug is the stored activeWorkspaceSlug (set on line 438
  // to data.workspace.name); today slug === name for all existing sessions. If a
  // future rename sanitizes slug to a lowercase form, update this comparison to
  // compare against workspace.id (publicId) or keep a stored workspace.name field.
  if (
    prior &&
    (prior.email !== data.user.email || prior.workspaceSlug !== data.workspace.name)
  ) {
    console.log(
      `${c.success(icon.success)} Replaced previous session (was: ${prior.email} — workspace "${prior.workspaceSlug}")`,
    );
  }
  console.log(
    `${c.success(icon.success)} Logged in as ${data.user.email} — workspace "${data.workspace.name}"`,
  );

  await runWizard({ phone: opts.phone, next: opts.next, json: opts.json });
}

export function loginCommand(program: Command): void {
  const login = program
    .command('login')
    .description('Authenticate with HookMyApp via browser')
    .option('--phone <phone>', 'Skip sandbox session picker; use this phone')
    .option(
      '--wizard',
      'Run the post-login wizard (default after browser sign-in)',
      false,
    )
    .option(
      '--next <action>',
      'Non-interactive next-action for scripts/CI (sandbox|channels|exit)',
    )
    .option(
      '--code <code>',
      'Exchange a dashboard-minted bootstrap code (zero browser interaction)',
    )
    .action(
      async (opts: {
        phone?: string;
        wizard?: boolean;
        next?: string;
        code?: string;
      }) => {
        const nextAction =
          opts.next === 'sandbox' || opts.next === 'channels' || opts.next === 'exit'
            ? opts.next
            : undefined;
        const json = program.opts().json === true;

        // Phase 122 — bootstrap-code branch. MUST run BEFORE the wizard
        // fast-path and BEFORE device-flow initiation so --code --wizard is
        // flagged as a programming error (mutually exclusive).
        if (opts.code) {
          if (opts.wizard) {
            throw new ValidationError(
              '--code and --wizard are mutually exclusive.',
            );
          }
          await runBootstrapCodeExchange(opts.code, {
            phone: opts.phone,
            next: nextAction,
            json,
          });
          return;
        }

        // --wizard is the integration-test fast path: skip browser auth and
        // run the wizard directly against whatever credentials the seed
        // helper stashed in $HOME/.hookmyapp/credentials.json.
        if (opts.wizard) {
          await runWizard({ phone: opts.phone, next: nextAction, json });
          return;
        }

        let res: Response;
        try {
          res = await fetch('https://api.workos.com/user_management/authorize/device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: getEffectiveWorkosClientId() }),
          });
        } catch {
          throw new NetworkError();
        }

        if (!res.ok) {
          throw new AuthError('Failed to initiate login. Try again later.');
        }

        const { device_code, user_code, verification_uri_complete, interval, expires_in } =
          await res.json();

        console.log(`\nOpening browser to authenticate...\nCode: ${user_code}\n`);

        // Integration-test hook: when set, write the verification URI to a file
        // so the integration suite can drive a headless browser through it.
        if (process.env.HOOKMYAPP_LOGIN_URL_FILE) {
          const fs = await import('node:fs/promises');
          await fs.writeFile(process.env.HOOKMYAPP_LOGIN_URL_FILE, verification_uri_complete);
        }

        // Open browser
        const open = (await import('open')).default;
        await open(verification_uri_complete);

        await pollForTokens({
          clientId: getEffectiveWorkosClientId(),
          deviceCode: device_code,
          expiresIn: expires_in,
          interval,
        });

        // Auto-chain into the wizard.
        await runWizard({ phone: opts.phone, next: nextAction, json });
      },
    );

  addExamples(
    login,
    `
EXAMPLES:
  $ hookmyapp login
  $ hookmyapp login --code hma_boot_xxx                    # zero-browser AI paste
  $ hookmyapp login --workspace acme-corp                  # preselect workspace
  $ hookmyapp login --next sandbox --phone +15551234567    # scripts / CI

This runs the post-login wizard:
  1. Browser sign-in (or --code <bootstrap-code> to skip the browser)
  2. Workspace picker (if you belong to more than one)
  3. Prints a "Next steps" guide (or runs --next / --phone non-interactively)
`,
  );
}
