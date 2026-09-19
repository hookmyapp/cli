import { facebookVisible } from '../config/facebook-preview.js';
import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { readBodyFlag, assertBodyXorFlags } from './_body.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { assertFbId } from './facebook-ids.js';
import { registerFacebookInbox } from './facebook-inbox.js';
import { registerFacebookPosts } from './facebook-posts.js';
import { registerFacebookComments } from './facebook-comments.js';
import { registerFacebookInsights } from './facebook-insights.js';
import { registerFacebookProfile } from './facebook-profile.js';

export interface FbSendOpts {
  channel?: string;
  to?: string;
  text?: string;
  tag?: string;
  body?: string;
  data?: string;
}

export async function runFacebookMessagesSend(opts: FbSendOpts, cmd?: Command): Promise<void> {
  const bodyRaw = opts.body ?? opts.data;
  assertBodyXorFlags(Boolean(opts.text || opts.to || opts.tag), Boolean(bodyRaw));
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  let body: unknown;
  if (bodyRaw) {
    body = await readBodyFlag(bodyRaw);
  } else {
    if (!opts.to || !opts.text) throw new ValidationError('--to (PSID) and --text are required.', 'MISSING_TEXT_ARGS');
    const to = assertFbId(opts.to, 'psid', '--to');
    body = {
      recipient: { id: to },
      message: { text: opts.text },
      // Outside the 24-hour window a message needs a tag Meta allows.
      ...(opts.tag ? { messaging_type: 'MESSAGE_TAG', tag: opts.tag } : {}),
    };
  }
  const res = await gatewayRequest({ channel, method: 'POST', path: '/{page_id}/messages', body });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Sent. message_id=${res?.message_id ?? '(unknown)'}`) + '\n');
}

export async function runFacebookMessagesRead(opts: { channel?: string; to?: string }, cmd?: Command): Promise<void> {
  const to = assertFbId(opts.to, 'psid', '--to');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: '/{page_id}/messages',
    body: { recipient: { id: to }, sender_action: 'mark_seen' },
  });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Marked seen.') + '\n');
}

/** Registers `facebook messages send|read`. */
export function registerFacebookMessages(facebook: Command): void {
  const messages = facebook.command('messages').description('Send Messenger messages and mark them seen');

  addExamples(
    messages,
    `
EXAMPLES:
  $ hookmyapp facebook messages send --channel ch_XXXXXXXX --to <psid> --text "hi"
  $ hookmyapp facebook messages read --channel ch_XXXXXXXX --to <psid>
`,
  );

  const send = messages
    .command('send')
    .description('Send a Messenger message (--text shortcut, or complete --body)')
    .option('--channel <ref>', 'Channel: ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--to <psid>', 'Recipient PSID (from the inbound webhook)')
    .option('--text <text>', 'Text body')
    .option('--tag <tag>', 'Message tag for sending outside the 24-hour window')
    .option('--body <json|@file|->', 'Complete Meta {recipient,message} body (verbatim)')
    .option('-d, --data <json|@file|->', 'Alias for --body')
    .action(async function (this: Command, opts: FbSendOpts) {
      await runFacebookMessagesSend(opts, this);
    });

  const read = messages
    .command('read')
    .description('Mark a Messenger thread as seen')
    .option('--channel <ref>', 'Channel: ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--to <psid>', 'Sender PSID (from the inbound webhook)')
    .action(async function (this: Command, opts: { channel?: string; to?: string }) {
      await runFacebookMessagesRead(opts, this);
    });

  addExamples(
    send,
    `
EXAMPLES:
  $ hookmyapp facebook messages send --channel ch_XXXXXXXX --to <psid> --text "hi"
  $ hookmyapp facebook messages send --channel ch_XXXXXXXX --to <psid> --text "Your order shipped" --tag POST_PURCHASE_UPDATE
  $ hookmyapp facebook messages send --channel ch_XXXXXXXX --body @msg.json
`,
  );
  addExamples(
    read,
    `
EXAMPLES:
  $ hookmyapp facebook messages read --channel ch_XXXXXXXX --to <psid>
  $ hookmyapp facebook messages read --channel ch_XXXXXXXX --to <psid> --json
`,
  );
}

/** Registers the `facebook` (alias `fb`) command group plus its subcommands. */
export function registerFacebookCommand(program: Command): Command {
  const facebook = program
    .command('facebook', { hidden: !facebookVisible() })
    .alias('fb')
    .description('Facebook Page messages, posts, comments, publishing, and insights');

  addExamples(
    facebook,
    `
EXAMPLES:
  $ hookmyapp facebook --help
  $ hookmyapp fb --help
  $ hookmyapp facebook messages send --channel ch_XXXXXXXX --to <psid> --text "hi"
  $ hookmyapp facebook publish --channel ch_XXXXXXXX --message "We are open today"
  $ hookmyapp facebook comments list --channel ch_XXXXXXXX --post <page-id>_<post-id>
  $ hookmyapp facebook insights --channel ch_XXXXXXXX
`,
  );

  registerFacebookMessages(facebook);
  registerFacebookInbox(facebook);
  registerFacebookPosts(facebook);
  registerFacebookComments(facebook);
  registerFacebookInsights(facebook);
  registerFacebookProfile(facebook);

  return facebook;
}
