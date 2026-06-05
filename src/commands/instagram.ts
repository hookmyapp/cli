import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { readBodyFlag, assertBodyXorFlags } from './_body.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { registerInstagramComments } from './instagram-comments.js';

export interface IgSendOpts {
  channel?: string;
  to?: string;
  text?: string;
  body?: string;
  data?: string;
}

export async function runInstagramMessagesSend(opts: IgSendOpts, cmd?: Command): Promise<void> {
  const bodyRaw = opts.body ?? opts.data; // -d/--data alias of --body (D2)
  assertBodyXorFlags(Boolean(opts.text || opts.to), Boolean(bodyRaw));
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  let body: unknown;
  if (bodyRaw) {
    body = await readBodyFlag(bodyRaw);
  } else {
    if (!opts.to || !opts.text)
      throw new ValidationError('--to (IGSID) and --text are required.', 'MISSING_TEXT_ARGS');
    body = { recipient: { id: opts.to }, message: { text: opts.text } };
  }
  const res = await gatewayRequest({ channel, method: 'POST', path: `/{ig_id}/messages`, body });
  process.stdout.write(
    (cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Sent. message_id=${res?.message_id ?? '(unknown)'}`) + '\n',
  );
}

export interface IgReadOpts {
  channel?: string;
  to?: string;
}

export async function runInstagramMessagesRead(opts: IgReadOpts, cmd?: Command): Promise<void> {
  if (!opts.to) throw new ValidationError('--to (IGSID) is required.', 'MISSING_TO');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const body = { recipient: { id: opts.to }, sender_action: 'mark_seen' };
  const res = await gatewayRequest({ channel, method: 'POST', path: `/{ig_id}/messages`, body });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Marked seen.') + '\n');
}

/** Registers `instagram messages send|read`. */
export function registerInstagramMessages(instagram: Command): void {
  const messages = instagram.command('messages').description('Send Instagram DMs and mark them seen');

  addExamples(
    messages,
    `
EXAMPLES:
  $ hookmyapp instagram messages send --channel @acme --to <igsid> --text "hi"
  $ hookmyapp instagram messages read --channel @acme --to <igsid>
`,
  );

  const send = messages
    .command('send')
    .description('Send an Instagram DM (--text shortcut, or complete --body)')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--to <igsid>', 'Recipient IGSID (from the inbound webhook)')
    .option('--text <text>', 'Text body')
    .option('--body <json|@file|->', 'Complete Meta {recipient,message} body (verbatim)')
    .option('-d, --data <json|@file|->', 'Alias for --body')
    .action(async function (this: Command, opts: IgSendOpts) {
      await runInstagramMessagesSend(opts, this);
    });

  const read = messages
    .command('read')
    .description('Mark an Instagram DM thread as seen')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--to <igsid>', 'Sender IGSID (from the inbound webhook)')
    .action(async function (this: Command, opts: IgReadOpts) {
      await runInstagramMessagesRead(opts, this);
    });

  addExamples(
    send,
    `
EXAMPLES:
  $ hookmyapp instagram messages send --channel @acme --to <igsid> --text "hi"
  $ hookmyapp instagram messages send --channel @acme --body @msg.json
`,
  );

  addExamples(
    read,
    `
EXAMPLES:
  $ hookmyapp instagram messages read --channel @acme --to <igsid>
  $ hookmyapp instagram messages read --channel @acme --to <igsid> --json
`,
  );
}

/** Registers the `instagram` (alias `ig`) command group plus its subcommands. */
export function registerInstagramCommand(program: Command): Command {
  const instagram = program
    .command('instagram')
    .alias('ig')
    .description('Instagram comments and direct messages');

  addExamples(
    instagram,
    `
EXAMPLES:
  $ hookmyapp instagram --help
  $ hookmyapp ig --help
  $ hookmyapp instagram messages send --channel @acme --to <igsid> --text "hi"
  $ hookmyapp instagram comments reply --channel @acme --comment <id> --text "thanks!"
`,
  );

  registerInstagramMessages(instagram);
  registerInstagramComments(instagram);

  return instagram;
}
