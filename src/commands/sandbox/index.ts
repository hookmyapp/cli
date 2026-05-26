// `hookmyapp sandbox` — Commander registration. Wires the per-subcommand
// runX functions and attaches addExamples() to every command so help.test.ts
// continues to pass.

import type { Command } from 'commander';
import { addExamples } from '../../output/help.js';
import { runSandboxEnv } from './env.js';
import { runSandboxSend } from './send.js';
import { runSandboxStart } from './start.js';
import { runSandboxStatus } from './status.js';
import { runSandboxStop } from './stop.js';
import {
  runSandboxWebhookClear,
  runSandboxWebhookSet,
  runSandboxWebhookShow,
} from './webhook.js';

export function registerSandboxCommand(program: Command): void {
  const sandbox = program
    .command('sandbox')
    .description('Manage sandbox sessions for local development');

  const sandboxStart = sandbox
    .command('start')
    .description('Bind a sandbox session for local development')
    .option(
      '--type <whatsapp|instagram>',
      'Channel type (prompts if omitted; required in --json mode)',
    )
    .option('--listen', 'After bind, immediately start the webhook listener')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { type?: 'whatsapp' | 'instagram'; listen?: boolean; json?: boolean }) => {
      await runSandboxStart({ ...opts, json: !!(opts.json || program.opts().json) });
    });
  addExamples(
    sandboxStart,
    `EXAMPLES:
  $ hookmyapp sandbox start
  $ hookmyapp sandbox start --type=whatsapp
  $ hookmyapp sandbox start --type=instagram --listen
  $ hookmyapp sandbox start --type=whatsapp --json`,
  );

  const sandboxStatus = sandbox
    .command('status')
    .description('Show active sandbox sessions')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      await runSandboxStatus({ ...opts, json: !!(opts.json || program.opts().json) });
    });
  addExamples(
    sandboxStatus,
    `EXAMPLES:
  $ hookmyapp sandbox status
  $ hookmyapp sandbox status --json`,
  );

  const sandboxStop = sandbox
    .command('stop')
    .description('Delete a sandbox session')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Machine-readable output')
    .action(
      async (opts: {
        phone?: string;
        username?: string;
        session?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        await runSandboxStop({ ...opts, json: !!(opts.json || program.opts().json) });
      },
    );
  addExamples(
    sandboxStop,
    `EXAMPLES:
  $ hookmyapp sandbox stop
  $ hookmyapp sandbox stop --phone +15551234567
  $ hookmyapp sandbox stop --username @ordvir
  $ hookmyapp sandbox stop --session ssn_POWomFvq --yes`,
  );

  const sandboxEnv = sandbox
    .command('env')
    .description('Print or write your sandbox .env values')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--write [path]', 'Write to file (default ./.env)')
    .option('--force', 'Overwrite without prompt')
    .option('--json', 'Machine-readable output')
    .action(
      async (opts: {
        phone?: string;
        username?: string;
        session?: string;
        write?: string | boolean;
        force?: boolean;
        json?: boolean;
      }) => {
        await runSandboxEnv({ ...opts, json: !!(opts.json || program.opts().json) });
      },
    );
  addExamples(
    sandboxEnv,
    `EXAMPLES:
  $ hookmyapp sandbox env
  $ hookmyapp sandbox env --phone +15551234567 --write .env
  $ hookmyapp sandbox env --username @ordvir --write
  $ hookmyapp sandbox env --session ssn_POWomFvq --json`,
  );

  const sandboxSend = sandbox
    .command('send')
    .description('Send a test message via the shared sandbox-proxy')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--message <text>', 'Message body')
    .option('--json', 'Machine-readable output')
    .action(
      async (opts: {
        phone?: string;
        username?: string;
        session?: string;
        message?: string;
        json?: boolean;
      }) => {
        await runSandboxSend({ ...opts, json: !!(opts.json || program.opts().json) });
      },
    );
  addExamples(
    sandboxSend,
    `EXAMPLES:
  $ hookmyapp sandbox send --phone +15551234567 --message "hi"
  $ hookmyapp sandbox send --username @ordvir --message "hello"
  $ hookmyapp sandbox send --session ssn_POWomFvq --message "ack"`,
  );

  const sandboxWebhook = sandbox
    .command('webhook')
    .description('Manage the destination webhook URL for a sandbox session');

  const webhookShow = sandboxWebhook
    .command('show')
    .description('Show the current webhook URL on a sandbox session')
    .argument('[phone]', '[deprecated] Use --phone instead. Removed in 0.13.0.')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        positionalPhone: string | undefined,
        opts: { phone?: string; username?: string; session?: string; json?: boolean },
      ) => {
        await runSandboxWebhookShow({ positionalPhone, ...opts, json: !!(opts.json || program.opts().json) });
      },
    );
  addExamples(
    webhookShow,
    `EXAMPLES:
  $ hookmyapp sandbox webhook show --phone +15551234567
  $ hookmyapp sandbox webhook show --username @ordvir
  $ hookmyapp sandbox webhook show --session ssn_POWomFvq`,
  );

  const webhookSet = sandboxWebhook
    .command('set')
    .description('Point this sandbox session at a custom webhook URL')
    .argument('[phone]', '[deprecated] Use --phone instead. Removed in 0.13.0.')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--url <url>', 'Webhook URL')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        positionalPhone: string | undefined,
        opts: {
          phone?: string;
          username?: string;
          session?: string;
          url?: string;
          json?: boolean;
        },
      ) => {
        await runSandboxWebhookSet({ positionalPhone, ...opts, json: !!(opts.json || program.opts().json) });
      },
    );
  addExamples(
    webhookSet,
    `EXAMPLES:
  $ hookmyapp sandbox webhook set --phone +15551234567 --url https://my.example/hook
  $ hookmyapp sandbox webhook set --username @ordvir --url https://my.example/hook
  $ hookmyapp sandbox webhook set --session ssn_POWomFvq --url https://my.example/hook`,
  );

  const webhookClear = sandboxWebhook
    .command('clear')
    .description(
      'Clear a custom webhook URL on a sandbox session (revert to HookMyApp CLI tunnel)',
    )
    .argument('[phone]', '[deprecated] Use --phone instead. Removed in 0.13.0.')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        positionalPhone: string | undefined,
        opts: { phone?: string; username?: string; session?: string; json?: boolean },
      ) => {
        await runSandboxWebhookClear({ positionalPhone, ...opts, json: !!(opts.json || program.opts().json) });
      },
    );
  addExamples(
    webhookClear,
    `EXAMPLES:
  $ hookmyapp sandbox webhook clear --phone +15551234567
  $ hookmyapp sandbox webhook clear --username @ordvir`,
  );

  addExamples(
    sandbox,
    `EXAMPLES:
  $ hookmyapp sandbox start --type=instagram
  $ hookmyapp sandbox status
  $ hookmyapp sandbox env --username @ordvir --write
  $ hookmyapp sandbox send --username @ordvir --message "hello"`,
  );

  addExamples(
    sandboxWebhook,
    `EXAMPLES:
  $ hookmyapp sandbox webhook show --phone +15551234567
  $ hookmyapp sandbox webhook set --username @ordvir --url https://my.example/hook
  $ hookmyapp sandbox webhook clear --session ssn_POWomFvq`,
  );
}
