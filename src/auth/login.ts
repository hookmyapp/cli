import { Command } from 'commander';
import { saveCredentials } from './store.js';
import { AuthError, NetworkError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { c, icon } from '../output/color.js';

const WORKOS_CLIENT_ID = process.env.HOOKMYAPP_WORKOS_CLIENT_ID ?? 'client_01KM5S4D10TKG4VJEXSCRVAMG7';

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
  activationCode: string;
  hmacSecret: string;
}

export interface WizardOpts {
  /** Skip sandbox session picker; use this phone (creates it if missing). */
  phone?: string;
  /** Non-interactive action selector (integration-test hook). */
  next?: 'sandbox' | 'accounts' | 'exit';
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

  throw new AuthError('Login timed out. Try again: hookmyapp login');
}

/**
 * Post-login wizard. Directly dispatched (never via subprocess) after
 * pollForTokens succeeds.
 *
 * 1. Fetch workspaces → single silent-select OR multi-select picker.
 * 2. Persist active workspace + refresh JWT for picked org.
 * 3. Next-action picker (default "sandbox").
 * 4. Auto-chain into the chosen sub-flow via direct function import.
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
        'hookmyapp workspace new <name>',
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
    // Refresh JWT so subsequent calls are scoped to the picked org.
    if (activeWorkspaceOrg) {
      try {
        await forceTokenRefresh(activeWorkspaceOrg);
      } catch {
        // non-fatal: next apiClient call will surface auth errors
      }
    }
  }

  // Step 2 — next-action picker.
  type NextAction = 'sandbox' | 'accounts' | 'exit';
  let action: NextAction;
  if (opts.next) {
    action = opts.next;
  } else {
    action = (await select<NextAction>({
      message: 'What next?',
      default: 'sandbox',
      choices: [
        { name: 'Start sandbox session (recommended)', value: 'sandbox' },
        { name: 'Connect a WhatsApp Business account', value: 'accounts' },
        { name: 'Exit', value: 'exit' },
      ],
    })) as NextAction;
  }

  if (action === 'sandbox') {
    await runSandboxFlow({ phone: opts.phone, json: opts.json });
    return;
  }
  if (action === 'accounts') {
    await runAccountsConnectFlow();
    return;
  }

  // action === 'exit' → emit completion payload for --json callers.
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, workspaceId: activeWorkspaceId, next: 'exit' }) + '\n',
    );
  }
}

/**
 * Sandbox sub-flow. Invoked by the wizard OR (future) by a standalone
 * `hookmyapp sandbox session` helper.
 *
 * 0 sessions → prompt phone → create → listen.
 * 1 session  → direct listen (no prompt, no picker).
 * N sessions → picker with "+ Create new" option → listen.
 * --phone    → authoritative: match existing OR create → listen.
 */
export async function runSandboxFlow(
  opts: { phone?: string; json?: boolean } = {},
): Promise<void> {
  const { apiClient } = await import('../api/client.js');
  const { readWorkspaceConfig } = await import('../commands/workspace.js');
  const { select, input } = await import('@inquirer/prompts');
  const { runSandboxListenFlow } = await import('../commands/sandbox-listen/index.js');

  const config = readWorkspaceConfig();
  const workspaceId = config.activeWorkspaceId;
  if (!workspaceId) {
    throw new ValidationError(
      'No active workspace. Run: hookmyapp workspace use <name>',
    );
  }

  const sessions = (await apiClient('/sandbox/sessions?active=true', {
    method: 'GET',
    workspaceId,
  })) as SandboxSessionLite[];

  // --phone is authoritative: bypass every picker.
  if (opts.phone) {
    const normalized = opts.phone.replace(/^\+/, '');
    const match = sessions.find(
      (s) => s.phone && s.phone.replace(/^\+/, '') === normalized,
    );
    if (match) {
      await startListen(match, workspaceId, opts.json);
      return;
    }
    // Not found → create (ConflictError bubbles up for PHONE_TAKEN_ANOTHER etc).
    const created = await createSession(workspaceId, opts.phone);
    await startListen(created, workspaceId, opts.json);
    return;
  }

  // --json mode cannot prompt; require an explicit --phone.
  if (opts.json) {
    throw new ValidationError(
      'In --json mode, pass --phone <e164> to select or create a sandbox session.',
    );
  }

  if (sessions.length === 0) {
    const phone = await input({
      message: 'Sandbox phone (E.164, e.g. +15551234567):',
      validate: (v: string) =>
        /^\+\d{6,15}$/.test(v) ? true : 'Enter a valid E.164 phone (starts with +)',
    });
    const created = await createSession(workspaceId, phone);
    await startListen(created, workspaceId, opts.json);
    return;
  }

  if (sessions.length === 1) {
    await startListen(sessions[0], workspaceId, opts.json);
    return;
  }

  // N sessions → picker with + Create new sentinel.
  const CREATE_NEW = '__CREATE_NEW__';
  const choice = (await select<SandboxSessionLite | string>({
    message: 'Select a sandbox session',
    choices: [
      ...sessions.map((s) => ({
        name: `+${(s.phone ?? '').replace(/^\+/, '')} (${s.status})`,
        value: s as SandboxSessionLite | string,
      })),
      { name: c.dim('+ Create new'), value: CREATE_NEW as SandboxSessionLite | string },
    ],
  })) as SandboxSessionLite | string;

  if (choice === CREATE_NEW) {
    const phone = await input({
      message: 'Sandbox phone (E.164):',
      validate: (v: string) =>
        /^\+\d{6,15}$/.test(v) ? true : 'Enter a valid E.164 phone',
    });
    const created = await createSession(workspaceId, phone);
    await startListen(created, workspaceId, opts.json);
    return;
  }

  await startListen(choice as SandboxSessionLite, workspaceId, opts.json);
}

async function createSession(
  workspaceId: string,
  phone: string,
): Promise<SandboxSessionLite> {
  const { apiClient } = await import('../api/client.js');
  return (await apiClient('/sandbox/sessions', {
    method: 'POST',
    body: JSON.stringify({ phone }),
    workspaceId,
  })) as SandboxSessionLite;
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

async function runAccountsConnectFlow(): Promise<void> {
  // Direct function import — never subprocess spawn. Lazy import breaks the
  // index.ts → commands/accounts.ts → auth/login.ts cycle.
  const { runAccountsConnect } = await import('../commands/accounts.js');
  await runAccountsConnect();
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
      'Non-interactive next-action for scripts/CI (sandbox|accounts|exit)',
    )
    .action(
      async (opts: { phone?: string; wizard?: boolean; next?: string }) => {
        const nextAction =
          opts.next === 'sandbox' || opts.next === 'accounts' || opts.next === 'exit'
            ? opts.next
            : undefined;
        const json = program.opts().json === true;

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
            body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
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
          clientId: WORKOS_CLIENT_ID,
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
  $ hookmyapp login --workspace acme-corp

This runs the post-login wizard:
  1. Browser sign-in
  2. Workspace picker (if you belong to more than one)
  3. Next-action picker (Start sandbox session / Connect WhatsApp / Exit)
  4. If you pick sandbox, it auto-chains into \`hookmyapp sandbox listen\`
`,
  );
}
