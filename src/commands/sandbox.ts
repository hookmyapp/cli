import * as fs from 'node:fs';
import type { Command } from 'commander';
import { input, confirm, select } from '@inquirer/prompts';
import qrcode from 'qrcode-terminal';
import ora from 'ora';
import pc from 'picocolors';
import { apiClient, getBindCode } from '../api/client.js';
import { output } from '../output/format.js';
import {
  ValidationError,
  ApiError,
  AuthError,
  ConflictError,
  SessionWindowError,
} from '../output/error.js';
import { addExamples } from '../output/help.js';
import { c, icon } from '../output/color.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import {
  getEffectiveSandboxProxyUrl,
  getEffectiveSandboxWhatsAppNumber,
} from '../config/env-profiles.js';
import { getDefaultWorkspaceId } from './_helpers.js';
import { pickSessionByPhone, type Session as ListenSession } from './sandbox-listen/picker.js';
import { runSandboxListenFlow } from './sandbox-listen/index.js';

interface SandboxSession {
  id: string;
  publicId?: string;
  workspaceId: string;
  phone: string | null;
  // Phase 126 rename: consumed bind code doubles as the bearer token for
  // sandbox-proxy. See .planning/phases/126-sandbox-rework-session-onboarding/
  // 126-CONTEXT.md §1 for the rename rationale.
  accessToken: string;
  status: 'pending_activation' | 'active' | 'replaced' | 'expired';
  webhookUrl: string | null;
  // Cloudflare tunnel fields (populated only while a tunnel is live via
  // `hookmyapp sandbox listen`; see Phase 107 for the full lifecycle).
  cloudflareTunnelId: string | null;
  cloudflareTunnelToken: string | null;
  hostname: string | null;
  lastHeartbeatAt: string | null;
  hmacSecret: string;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Shared sandbox WABA phone-number-id (Phase 260415-jmg). Same value on
  // every session — populated from backend SANDBOX_PHONE_NUMBER_ID env so
  // the CLI doesn't round-trip through a separate config endpoint.
  sandboxPhoneNumberId: string | null;
  // Graph API version the CLI should target when composing the sandbox-proxy
  // URL. Server-delivered from backend META_GRAPH_VERSION so a Meta Graph
  // bump doesn't require a CLI release.
  whatsappApiVersion: string;
}

// Canonical 5-line .env block emitted by `hookmyapp sandbox env`. Must stay
// in sync with 108-CONTEXT.md §"Env var alignment" — the CLI is the single
// source of truth for starter-kit developers copy/pasting these values.
//
// `whatsappApiVersion` arrives on the session from the backend. Composed with
// the env-aware proxy host so a Graph API version bump is server-only.
function buildEnvBlock(session: {
  phone: string | null;
  accessToken: string;
  hmacSecret: string;
  whatsappApiVersion: string;
}): string {
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  return [
    `VERIFY_TOKEN=${session.hmacSecret}`,
    `PORT=3000`,
    `WHATSAPP_API_URL=${proxyBase}/${session.whatsappApiVersion}`,
    `WHATSAPP_ACCESS_TOKEN=${session.accessToken}`,
    `WHATSAPP_PHONE_NUMBER_ID=${session.phone ?? ''}`,
    '',
  ].join('\n');
}

/**
 * `hookmyapp sandbox env` — print or write the canonical .env block for a
 * sandbox session. Pipe-safe by default (writes directly to stdout, no
 * trailing UI chrome). Use `--write` to write to disk with a clobber prompt.
 *
 * Exported for unit tests; the Commander registration in
 * `registerSandboxCommand` delegates here.
 */
export async function runSandboxEnv(opts: {
  phone?: string;
  write?: string | boolean;
  force?: boolean;
  json?: boolean;
}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const sessions = (await apiClient('/sandbox/sessions?active=true', {
    workspaceId,
  })) as SandboxSession[];
  const session = await pickSessionByPhone(sessions, opts.phone);

  const content = buildEnvBlock(session);

  // Default: print to stdout. Use process.stdout.write (not console.log) so
  // the output is pipe-safe — `hookmyapp sandbox env > .env` produces the
  // block with no extra trailing newline beyond the one already in `content`.
  if (opts.write === undefined) {
    process.stdout.write(content);
    return;
  }

  const target = typeof opts.write === 'string' ? opts.write : '.env';
  if (fs.existsSync(target) && !opts.force) {
    // In JSON mode, prompting would hang scripts — surface a ValidationError
    // so callers see exit 2 + a clear remediation (--force / --write=<path>).
    // Human mode (default) confirms interactively, with a safe default=no.
    if (opts.json) {
      throw new ValidationError(
        `${target} exists — pass --force to overwrite (or --write=<other-path>)`,
      );
    }
    const ok = await confirm({
      message: `${target} already exists. Overwrite?`,
      default: false,
    });
    if (!ok) return; // graceful exit 0 — user declined
  }
  fs.writeFileSync(target, content);
}

interface SendFlags {
  phone?: string;
  message?: string;
  json?: boolean;
}

/**
 * `hookmyapp sandbox send` — send a one-shot WhatsApp message via the shared
 * sandbox-proxy. Fully flagged path bypasses all prompts (CI-friendly);
 * partial flags prompt only for the missing fields.
 *
 * Exported for unit tests.
 */
export async function runSandboxSend(opts: SendFlags): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const sessions = (await apiClient('/sandbox/sessions?active=true', {
    workspaceId,
  })) as SandboxSession[];

  // Always-show picker for `sandbox send` (intentionally differs from
  // `sandbox env` which keeps silent auto-pick to stay pipe-safe).
  const session = await pickSendSession(sessions, opts.phone);

  if (!session.sandboxPhoneNumberId) {
    throw new ApiError(
      'Sandbox phone number id is not configured on the backend. Ask your admin to set SANDBOX_PHONE_NUMBER_ID.',
      500,
    );
  }

  // In the sandbox, the recipient is ALWAYS the session's own phone — the
  // customer who activated it. Sending to any other number would defeat the
  // activation handshake and silently burn Meta quota. Enforced server-side
  // in sandbox-proxy too; no CLI flag can override.
  if (!session.phone) {
    throw new ValidationError(
      'Selected session has no phone on record — cannot send. Run `sandbox start` to create a fresh session.',
    );
  }
  const toStripped = session.phone.replace(/^\+/, '');
  const message =
    opts.message ??
    (await input({
      message: 'Message:',
      validate: (v: string) =>
        v.length > 0 ? true : 'Message cannot be empty',
    }));
  // Env-aware proxy base (Phase 260415-jmg). HOOKMYAPP_SANDBOX_PROXY_URL
  // still wins as a surgical override. Graph API version comes from the
  // session (server-delivered) — bumps don't require a CLI release.
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  // CRITICAL: route uses the SANDBOX WABA phone_number_id (shared across
  // workspaces), NOT the customer's test phone — that was the pre-260415-jmg
  // bug. The proxy rewrites this to the real Meta phone number id at egress.
  const url = `${proxyBase}/${session.whatsappApiVersion}/${session.sandboxPhoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toStripped,
      type: 'text',
      text: { body: message },
    }),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Surface 24h-window 403 verbatim with actionable guidance instead of
    // a generic "Send failed" — recipient just needs to message first.
    if (res.status === 403 && body?.code === 'SESSION_WINDOW_CLOSED') {
      throw new SessionWindowError(
        body.message ??
          'Recipient has not sent an inbound message in the last 24 hours.',
      );
    }
    const msg: string =
      body?.error?.message ?? body?.message ?? `Send failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }

  if (opts.json) {
    output(body, { json: true });
    return;
  }
  const msgId = body?.messages?.[0]?.id ?? '?';
  console.log(
    `${c.success(icon.success)} Message sent to +${toStripped} (id: ${msgId})`,
  );
}

/**
 * Local picker for `sandbox send`. Differs from `pickSessionByPhone` (used
 * by `sandbox env`) in one key way: when no `--phone` flag is provided, we
 * ALWAYS show the select picker — even with a single session. This forces
 * the user to confirm the sender (preventing accidental sends from the
 * wrong test phone) and matches Phase 260415-jmg's UX requirement.
 */
async function pickSendSession(
  sessions: SandboxSession[],
  phoneFlag?: string,
): Promise<SandboxSession> {
  if (sessions.length === 0) {
    throw new ValidationError(
      `No active sandbox sessions. Run: ${cliCommandPrefix()} sandbox start`,
    );
  }

  if (phoneFlag) {
    const normalized = phoneFlag.replace(/^\+/, '');
    const match = sessions.find(
      (s) => s.phone && s.phone.replace(/^\+/, '') === normalized,
    );
    if (!match) {
      const avail = sessions
        .map((s) =>
          s.phone ? `+${s.phone.replace(/^\+/, '')}` : '(no phone)',
        )
        .join(', ');
      throw new ValidationError(
        `No sandbox session for ${phoneFlag}. Available: ${avail}. ` +
          `Run: ${cliCommandPrefix()} sandbox status`,
      );
    }
    return match;
  }

  // No --phone flag → always show picker (even for 1 session, intentionally).
  return await select<SandboxSession>({
    message: 'Select sender session',
    choices: sessions.map((s) => ({
      name: `+${(s.phone ?? '').replace(/^\+/, '') || '(no phone)'} (${s.status})`,
      value: s,
    })),
  });
}

/**
 * `hookmyapp sandbox start` — Phase 126 bind-code flow.
 *
 * 1. Fetch the caller's available bind code for the active workspace via
 *    `getBindCode(workspaceId)` (GET /sandbox/bind-code, Plan 03 contract).
 * 2. Print the code + (TTY-only) terminal QR of the wa.me URL + raw URL as
 *    fallback for non-Unicode terminals.
 * 3. Poll `getBindCode` every 2s until `consumedSessionId` populates. Ctrl+C
 *    cancels cleanly; after 5min the spinner warns once + keeps polling (no
 *    hard timeout — the user left the terminal open on purpose).
 * 4. Fetch the consumed session via `GET /sandbox/sessions/:sessionPublicId`;
 *    announce `✓ Session created. Phone: {phone}. Token: {accessToken}`.
 * 5. If `--listen` is passed, chain in-process into `runSandboxListenFlow`
 *    (NEVER subprocess spawn — matches Phase 108 CLI-108-02 `runSandboxFlow`
 *    precedent).
 *
 * Errors flow through `mapApiError`: 401 → AuthError (exit 4), 409 →
 * ConflictError (exit 6; phone already bound to another workspace), 5xx →
 * ApiError (exit 1).
 *
 * Exported for unit tests; the Commander registration in
 * `registerSandboxCommand` delegates here.
 */
export async function runSandboxStart(opts: {
  workspace?: string;
  listen?: boolean;
  json?: boolean;
}): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const workspaceId = await getDefaultWorkspaceId();

  // 1. Fetch bind code.
  const bindRes = await getBindCode(workspaceId);
  const bindCode = bindRes.code;
  const waUrl = `https://wa.me/${getEffectiveSandboxWhatsAppNumber()}?text=${bindCode}`;

  // 2. Header + instruction + code display + QR + raw URL fallback.
  //
  // picocolors is imported directly here (rather than only via `c` from
  // ../output/color.js) because `c` exposes the subset of styles the rest of
  // the CLI uses (success/error/warn/dim); the start banner needs bold + cyan
  // which aren't in that subset, and wrapping them would be dead code for the
  // Phase 126 flow's one callsite.
  console.log();
  console.log(isTty ? pc.bold('Start a sandbox testing session') : 'Start a sandbox testing session');
  console.log(
    isTty
      ? c.dim('Send this code to the sandbox WhatsApp number from the phone you want to bind.')
      : 'Send this code to the sandbox WhatsApp number from the phone you want to bind.',
  );
  console.log();
  console.log(isTty ? `  ${pc.bold(pc.cyan(bindCode))}` : `  ${bindCode}`);
  console.log();

  if (isTty) {
    qrcode.generate(waUrl, { small: true });
    console.log();
  }

  console.log(isTty ? c.dim(`Or open: ${waUrl}`) : `Or open: ${waUrl}`);
  console.log();

  // 3. Poll loop with spinner + Ctrl+C trap + 5-minute soft warning.
  const spinner = isTty ? ora('Waiting for your WhatsApp message…') : null;
  spinner?.start();

  const onSigint = (): void => {
    spinner?.stop();
    console.log();
    console.log(
      isTty
        ? c.dim(
            'Cancelled. Your bind code is still valid — run `hookmyapp sandbox start` again to resume.',
          )
        : 'Cancelled. Your bind code is still valid — run `hookmyapp sandbox start` again to resume.',
    );
    process.exit(0);
  };
  process.once('SIGINT', onSigint);

  const started = Date.now();
  let warned = false;
  let session: SandboxSession;

  try {
    while (true) {
      try {
        const latest = await getBindCode(workspaceId);
        if (latest.consumedSessionId) {
          // 4. Fetch session detail.
          session = (await apiClient(
            `/sandbox/sessions/${latest.consumedSessionId}`,
            { workspaceId },
          )) as SandboxSession;
          spinner?.succeed(
            `Session created. Phone: ${session.phone ?? '(unknown)'}. Token: ${session.accessToken}`,
          );
          if (!isTty) {
            // Non-TTY fallback — spinner.succeed is a no-op when spinner is null.
            console.log(
              `Session created. Phone: ${session.phone ?? '(unknown)'}. Token: ${session.accessToken}`,
            );
          }
          break;
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          spinner?.fail(
            'This number is already bound to another workspace. Remove the existing binding first.',
          );
          if (!isTty) {
            console.error(
              'This number is already bound to another workspace. Remove the existing binding first.',
            );
          }
          throw err; // mapApiError already set exit 6
        }
        if (err instanceof AuthError) {
          spinner?.fail("You're not logged in. Run `hookmyapp login` first.");
          if (!isTty) {
            console.error("You're not logged in. Run `hookmyapp login` first.");
          }
          throw err; // mapApiError already set exit 4
        }
        // Other transient errors (5xx, network) — don't fail the spinner;
        // the next poll will retry. mapApiError already surfaced a typed
        // subclass; suppress here and let the next tick re-attempt.
      }

      if (!warned && Date.now() - started > 5 * 60 * 1000) {
        spinner?.warn('Still waiting. Press Ctrl+C to cancel, or leave this running.');
        spinner?.start('Waiting for your WhatsApp message…');
        warned = true;
      }

      await sleep(2000);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  // 5. Optional --listen chain (in-process).
  if (opts.listen) {
    console.log(
      isTty
        ? c.dim('→ Starting sandbox listener…')
        : '→ Starting sandbox listener…',
    );
    const listenSession: ListenSession = {
      id: session.publicId ?? session.id,
      phone: session.phone,
      workspaceId: session.workspaceId,
      status: session.status,
      lastHeartbeatAt: session.lastHeartbeatAt,
    };
    await runSandboxListenFlow(listenSession, {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerSandboxCommand(program: Command): void {
  const sandbox = program.command('sandbox').description('Manage sandbox sessions for local development');

  const sandboxStart = sandbox
    .command('start')
    .description('Bind your WhatsApp phone to this workspace and start a sandbox session')
    .option('--listen', 'After bind, immediately start the webhook listener')
    .action(async (opts: { listen?: boolean }) => {
      await runSandboxStart({
        listen: opts.listen,
        json: !!program.opts().json,
      });
    });

  const sandboxStatus = sandbox
    .command('status')
    .description('Show active sandbox sessions')
    .action(async () => {
      const workspaceId = await getDefaultWorkspaceId();
      const sessions: SandboxSession[] = await apiClient('/sandbox/sessions', { workspaceId });

      const human = !program.opts().json;
      if (!human) {
        output(sessions, { human: false });
        return;
      }

      if (sessions.length === 0) {
        console.log(`No sandbox sessions. Run: ${cliCommandPrefix()} sandbox start`);
        return;
      }

      for (const session of sessions) {
        const phone = session.phone ? `+${session.phone.replace(/^\+/, '')}` : '(none)';
        console.log(`\nSandbox session for ${phone}`);
        console.log(`  Status:          ${session.status}`);
        console.log(`  Access Token:    ${session.accessToken}`);
        console.log(`  Tunnel Host:     ${session.hostname ?? '(no live tunnel)'}`);
        console.log(`  Webhook URL:     ${session.webhookUrl ?? '(not set — run sandbox listen)'}`);
        console.log(`  Activated At:    ${session.activatedAt ?? '(not yet)'}`);

        if (session.status === 'active') {
          console.log('');
          printActiveSteps(session);
        }
      }
    });

  const sandboxStop = sandbox
    .command('stop')
    .description('Delete a sandbox session')
    .action(async () => {
      const workspaceId = await getDefaultWorkspaceId();
      const sessions: SandboxSession[] = await apiClient('/sandbox/sessions', { workspaceId });

      if (sessions.length === 0) {
        throw new ValidationError(
          `No sandbox sessions found. Run: ${cliCommandPrefix()} sandbox start`,
        );
      }

      let sessionToDelete: SandboxSession;

      const phoneLabel = (s: SandboxSession): string =>
        s.phone ? `+${s.phone.replace(/^\+/, '')}` : 'no phone';

      if (sessions.length === 1) {
        sessionToDelete = sessions[0];
        const proceed = await confirm({
          message: `Delete sandbox session for ${phoneLabel(sessionToDelete)}? This will tear down your tunnel.`,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }
      } else {
        const choice = await select({
          message: 'Which session do you want to delete?',
          choices: sessions.map((s) => ({
            name: `${phoneLabel(s)} (${s.status})`,
            value: s.id,
          })),
        });
        sessionToDelete = sessions.find((s) => s.id === choice)!;
        const proceed = await confirm({
          message: `Delete sandbox session for ${phoneLabel(sessionToDelete)}? This will tear down your tunnel.`,
        });
        if (!proceed) {
          console.log('Cancelled.');
          return;
        }
      }

      await apiClient(`/sandbox/sessions/${sessionToDelete.id}`, {
        method: 'DELETE',
        workspaceId,
      });

      const human = !program.opts().json;
      if (human) {
        console.log(`\nSandbox session for ${phoneLabel(sessionToDelete)} deleted.\n`);
      } else {
        output({ deleted: true, id: sessionToDelete.id }, { human: false });
      }
    });

  const sandboxEnv = sandbox
    .command('env')
    .description('Print or write your sandbox .env values')
    .option('--phone <phone>', 'Select session by phone')
    .option('--write [path]', 'Write to file (default ./.env)')
    .option('--force', 'Overwrite without prompt')
    .action(
      async (opts: {
        phone?: string;
        write?: string | boolean;
        force?: boolean;
      }) => {
        await runSandboxEnv({ ...opts, json: !!program.opts().json });
      },
    );

  const sandboxSend = sandbox
    .command('send')
    .description(
      'Reply to a sandbox session (recipient is the session phone — sandbox cannot send to any other number)',
    )
    .option('--phone <phone>', 'Select session by phone')
    .option('--message <text>', 'Message body')
    .action(async (opts: { phone?: string; message?: string }) => {
      await runSandboxSend({ ...opts, json: !!program.opts().json });
    });

  addExamples(
    sandbox,
    `
EXAMPLES:
  $ hookmyapp sandbox start
  $ hookmyapp sandbox start --listen
  $ hookmyapp sandbox listen
  $ hookmyapp sandbox status
`,
  );

  addExamples(
    sandboxStart,
    `
EXAMPLES:
  $ hookmyapp sandbox start
  $ hookmyapp sandbox start --listen
`,
  );

  addExamples(
    sandboxStatus,
    `
EXAMPLES:
  $ hookmyapp sandbox status
  $ hookmyapp sandbox status --json
`,
  );

  addExamples(
    sandboxStop,
    `
EXAMPLES:
  $ hookmyapp sandbox stop
  $ hookmyapp sandbox stop --workspace acme-corp
`,
  );

  addExamples(
    sandboxEnv,
    `
EXAMPLES:
  $ hookmyapp sandbox env                         # print to stdout
  $ hookmyapp sandbox env > .env                  # pipe to file
  $ hookmyapp sandbox env --write                 # write ./.env
  $ hookmyapp sandbox env --write=.env.sandbox    # write custom path
  $ hookmyapp sandbox env --phone +15551234567    # skip picker
`,
  );

  addExamples(
    sandboxSend,
    `
EXAMPLES:
  $ hookmyapp sandbox send                                          # prompts for session + message
  $ hookmyapp sandbox send --message "hi"                           # prompts only for session
  $ hookmyapp sandbox send --phone +15551234567 --message "hi"      # fully flagged (CI)
`,
  );
}

function printActiveSteps(session: SandboxSession): void {
  console.log(`  2. Start your tunnel:`);
  console.log(`     ${cliCommandPrefix()} sandbox listen --phone ${session.phone ?? '<your-test-phone>'}\n`);
  console.log(`  3. Clone the starter kit:`);
  console.log(`     npx degit hookmyapp/webhook-starter-kit my-app`);
  console.log(`     cd my-app && npm install\n`);
  console.log(`  4. Write your .env (canonical values from this session):`);
  console.log(`     ${cliCommandPrefix()} sandbox env --write .env\n`);
  console.log(`  5. Start your server:`);
  console.log(`     npm run dev\n`);
}
