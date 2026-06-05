import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { readBodyFlag, assertBodyXorFlags } from './_body.js';

// Re-export the shared body helpers for back-compat (moved to ./_body.ts in Plan 03 Task 0).
export { readBodyFlag, assertBodyXorFlags };

export interface WaSendOpts {
  channel?: string;
  to?: string;
  text?: string;
  body?: string;
  data?: string;
}

export async function runWhatsappMessagesSend(opts: WaSendOpts, cmd?: Command): Promise<void> {
  const bodyRaw = opts.body ?? opts.data; // -d/--data alias of --body (D2)
  assertBodyXorFlags(Boolean(opts.text || opts.to), Boolean(bodyRaw));
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  let body: unknown;
  if (bodyRaw) {
    body = await readBodyFlag(bodyRaw);
  } else {
    if (!opts.to || !opts.text)
      throw new ValidationError(
        '--to and --text are both required for the text shortcut.',
        'MISSING_TEXT_ARGS',
      );
    body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: 'text',
      text: { body: opts.text },
    };
  }
  const res = await gatewayRequest({ channel, method: 'POST', path: `/{phone_number_id}/messages`, body });
  process.stdout.write(
    (cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Sent. id=${res?.messages?.[0]?.id ?? '(unknown)'}`) + '\n',
  );
}

export interface WaReadOpts {
  channel?: string;
}

export async function runWhatsappMessagesRead(
  opts: WaReadOpts,
  messageId: string,
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const body = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
  const res = await gatewayRequest({ channel, method: 'POST', path: `/{phone_number_id}/messages`, body });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Marked read.') + '\n');
}

/** Registers `whatsapp messages send|read`. */
export function registerWhatsappMessages(whatsapp: Command): void {
  const messages = whatsapp.command('messages').description('Send WhatsApp messages and mark them read');

  addExamples(
    messages,
    `
EXAMPLES:
  $ hookmyapp whatsapp messages send --channel +1555 --to +1444 --text "hi"
  $ hookmyapp whatsapp messages read wamid.ABC --channel +1555
`,
  );

  const send = messages
    .command('send')
    .description('Send a WhatsApp message (--text shortcut, or complete --body)')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--to <phone>', 'Recipient phone (E.164)')
    .option('--text <text>', 'Text body (shortcut for a text message)')
    .option('--body <json|@file|->', 'Complete Meta message body (verbatim)')
    .option('-d, --data <json|@file|->', 'Alias for --body')
    .action(async function (this: Command, opts: WaSendOpts) {
      await runWhatsappMessagesSend(opts, this);
    });

  const read = messages
    .command('read')
    .description('Mark a received WhatsApp message as read')
    .argument('<message-id>', 'WhatsApp message id (wamid.…)')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .action(async function (this: Command, messageId: string, opts: WaReadOpts) {
      await runWhatsappMessagesRead(opts, messageId, this);
    });

  addExamples(
    send,
    `
EXAMPLES:
  $ hookmyapp whatsapp messages send --channel +1555 --to +1444 --text "hi"
  $ hookmyapp whatsapp messages send --channel +1555 --body @msg.json
`,
  );

  addExamples(
    read,
    `
EXAMPLES:
  $ hookmyapp whatsapp messages read wamid.ABC --channel +1555
  $ hookmyapp whatsapp messages read wamid.ABC --channel +1555 --json
`,
  );
}

/** Registers the `whatsapp` (alias `wa`) command group. Subcommands are added by registerWhatsappMessages/Templates/Media/Profile (Plan 02). */
export function registerWhatsappCommand(program: Command): Command {
  const whatsapp = program
    .command('whatsapp')
    .alias('wa')
    .description('WhatsApp messaging, templates, media, and business profile');

  addExamples(
    whatsapp,
    `
EXAMPLES:
  $ hookmyapp whatsapp --help
  $ hookmyapp wa --help
  $ hookmyapp whatsapp messages send --channel +1555 --to +1444 --text "hi"
  $ hookmyapp whatsapp templates list --channel +1555
  $ hookmyapp whatsapp media upload --channel +1555 --file ./a.jpg
  $ hookmyapp whatsapp profile get --channel +1555
`,
  );

  return whatsapp;
}
