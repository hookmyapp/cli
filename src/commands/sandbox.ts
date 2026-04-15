import * as fs from 'node:fs';
import type { Command } from 'commander';
import { input, confirm, select } from '@inquirer/prompts';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError, ApiError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { c, icon } from '../output/color.js';
import { getDefaultWorkspaceId } from './_helpers.js';
import { pickSessionByPhone } from './sandbox-listen/picker.js';

const SANDBOX_WHATSAPP_NUMBER = '972557046276';

interface SandboxSession {
  id: string;
  workspaceId: string;
  phone: string | null;
  activationCode: string;
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
}

// Canonical 5-line .env block emitted by `hookmyapp sandbox env`. Must stay
// in sync with 108-CONTEXT.md §"Env var alignment" — the CLI is the single
// source of truth for starter-kit developers copy/pasting these values.
function buildEnvBlock(session: {
  phone: string | null;
  activationCode: string;
  hmacSecret: string;
}): string {
  return [
    `VERIFY_TOKEN=${session.hmacSecret}`,
    `PORT=3000`,
    `WHATSAPP_API_URL=https://sandbox.hookmyapp.com/v22.0`,
    `WHATSAPP_ACCESS_TOKEN=${session.activationCode}`,
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
  to?: string;
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
  const session = await pickSessionByPhone(sessions, opts.phone);

  const to =
    opts.to ??
    (await input({
      message: 'To (E.164, e.g. +15550000):',
      validate: (v: string) =>
        /^\+\d{6,15}$/.test(v) ? true : 'Enter a valid E.164 phone',
    }));
  const message =
    opts.message ??
    (await input({
      message: 'Message:',
      validate: (v: string) =>
        v.length > 0 ? true : 'Message cannot be empty',
    }));

  const toStripped = to.replace(/^\+/, '');
  // Base URL is overridable via HOOKMYAPP_SANDBOX_PROXY_URL so the CLI
  // integration suite can point at the local sandbox-proxy container
  // (http://localhost:4315) instead of the production sandbox host.
  const proxyBase =
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL ?? 'https://sandbox.hookmyapp.com';
  const url = `${proxyBase.replace(/\/$/, '')}/v22.0/${session.phone}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.activationCode}`,
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
    `${c.success(icon.success)} Message sent to ${to} (id: ${msgId})`,
  );
}

export function registerSandboxCommand(program: Command): void {
  const sandbox = program.command('sandbox').description('Manage sandbox sessions for local development');

  const sandboxStart = sandbox
    .command('start')
    .description('Create a new sandbox session')
    .option('--phone <phone>', 'Phone number for WhatsApp activation')
    .action(async (opts: { phone?: string }) => {
      let phone = opts.phone;
      if (!phone) {
        phone = await input({
          message: 'Phone number for WhatsApp activation (e.g. +1234567890):',
        });
      }

      const workspaceId = await getDefaultWorkspaceId();
      const session: SandboxSession = await apiClient('/sandbox/sessions', {
        method: 'POST',
        body: JSON.stringify({ phone }),
        workspaceId,
      });

      const human = !program.opts().json;
      if (!human) {
        output(session, { human: false });
        return;
      }

      console.log(`\nSandbox session created!\n`);
      console.log(`  1. Send your activation code via WhatsApp:`);
      console.log(`     Open: https://wa.me/${SANDBOX_WHATSAPP_NUMBER}?text=${session.activationCode}\n`);

      if (session.status === 'active') {
        printActiveSteps(session);
      } else {
        console.log(`  Your session is pending activation.`);
        console.log(`  After sending the activation code, run:\n`);
        console.log(`     hookmyapp sandbox status\n`);
        console.log(`  to see your tunnel credentials and next steps.\n`);
      }
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
        console.log('No sandbox sessions. Run: hookmyapp sandbox start');
        return;
      }

      for (const session of sessions) {
        const phone = session.phone ? `+${session.phone.replace(/^\+/, '')}` : '(none)';
        console.log(`\nSandbox session for ${phone}`);
        console.log(`  Status:          ${session.status}`);
        console.log(`  Activation Code: ${session.activationCode}`);
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
          'No sandbox sessions found. Run: hookmyapp sandbox start',
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
    .description('Send a one-shot WhatsApp message via sandbox-proxy')
    .option('--phone <phone>', 'Select session by phone (your sender)')
    .option('--to <e164>', 'Recipient phone (E.164)')
    .option('--message <text>', 'Message body')
    .action(async (opts: { phone?: string; to?: string; message?: string }) => {
      await runSandboxSend({ ...opts, json: !!program.opts().json });
    });

  addExamples(
    sandbox,
    `
EXAMPLES:
  $ hookmyapp sandbox start --phone +15551234567
  $ hookmyapp sandbox listen
  $ hookmyapp sandbox status
`,
  );

  addExamples(
    sandboxStart,
    `
EXAMPLES:
  $ hookmyapp sandbox start --phone +15551234567
  $ hookmyapp sandbox start
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
  $ hookmyapp sandbox send                                                      # prompts for all fields
  $ hookmyapp sandbox send --to +15550000 --message "hi"                        # prompts only for session
  $ hookmyapp sandbox send --phone +15551234567 --to +15550000 --message "hi"   # fully flagged (CI)
`,
  );
}

function printActiveSteps(session: SandboxSession): void {
  console.log(`  2. Start your tunnel:`);
  console.log(`     hookmyapp sandbox listen --phone ${session.phone ?? '<your-test-phone>'}\n`);
  console.log(`  3. Clone the starter kit:`);
  console.log(`     npx degit hookmyapp/webhook-starter-kit my-app`);
  console.log(`     cd my-app && npm install\n`);
  console.log(`  4. Write your .env (canonical values from this session):`);
  console.log(`     hookmyapp sandbox env --write .env\n`);
  console.log(`  5. Start your server:`);
  console.log(`     npm run dev\n`);
}
