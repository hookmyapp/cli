import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

/** Read a --body value: inline JSON | @file | '-' (stdin). Returns the parsed object.
 *  Note: '-' reads stdin to EOF — intended for piped input (`… --body -` with a heredoc
 *  or a pipe). Run interactively without piped input it will block on stdin (expected). */
export async function readBodyFlag(body: string): Promise<unknown> {
  let raw = body;
  if (body === '-') {
    raw = await new Promise<string>((res, rej) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => res(buf));
      process.stdin.on('error', rej);
    });
  } else if (body.startsWith('@')) {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(body.slice(1), 'utf8');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('--body is not valid JSON.', 'BAD_BODY_JSON');
  }
}

/** Enforce D2 mutual-exclusivity: exactly one of (builder flags) or --body.
 *  Generic message — this helper is shared across send and profile update. */
export function assertBodyXorFlags(hasBuilderFlags: boolean, hasBody: boolean): void {
  if (hasBuilderFlags && hasBody)
    throw new ValidationError('Use either the builder flags or --body, not both.', 'BODY_AND_FLAGS');
  if (!hasBuilderFlags && !hasBody)
    throw new ValidationError('Provide either builder flags or --body.', 'NO_PAYLOAD');
}

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

  const send = messages
    .command('send')
    .description('Send a WhatsApp message (--text shortcut, or complete --body)')
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
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
    .option('--channel <ref>', 'Channel: +phone, @handle, or ch_id (defaults to config default-channel)')
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
