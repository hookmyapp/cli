import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { assertFbId, numericCommentId, pageSize } from './facebook-ids.js';

const COMMENT_FIELDS = 'id,from,message,created_time,is_hidden,parent';

export interface FbCommentsListOpts {
  channel?: string;
  post?: string;
  limit?: string;
}

export async function runFacebookCommentsList(opts: FbCommentsListOpts, cmd?: Command): Promise<void> {
  const post = assertFbId(opts.post, 'post', '--post');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const params = new URLSearchParams({ fields: COMMENT_FIELDS, filter: 'stream', limit: pageSize(opts.limit) });
  const res = await gatewayRequest({ channel, method: 'GET', path: `/${post}/comments?${params.toString()}` });
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }
  const rows: Array<{ id?: string; from?: { name?: string }; message?: string; is_hidden?: boolean }> = res?.data ?? [];
  if (rows.length === 0) {
    process.stdout.write('(no comments)\n');
    return;
  }
  for (const c of rows) {
    process.stdout.write(`${c.id ?? '(no-id)'}\t${c.from?.name ?? '(unknown)'}\t${c.is_hidden ? '[hidden] ' : ''}${c.message ?? ''}\n`);
  }
}

export interface FbCommentOpts {
  channel?: string;
  comment?: string;
  message?: string;
}

export async function runFacebookCommentsReply(opts: FbCommentOpts, cmd?: Command): Promise<void> {
  const comment = assertFbId(opts.comment, 'comment', '--comment');
  if (!opts.message) throw new ValidationError('--message is required.', 'MISSING_MESSAGE');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({ channel, method: 'POST', path: `/${comment}/comments`, body: { message: opts.message } });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Replied. id=${res?.id ?? '(unknown)'}`) + '\n');
}

export async function runFacebookCommentsHide(opts: FbCommentOpts, hide: boolean, cmd?: Command): Promise<void> {
  const comment = assertFbId(opts.comment, 'comment', '--comment');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({ channel, method: 'POST', path: `/${comment}`, body: { is_hidden: hide } });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : hide ? 'Hidden.' : 'Unhidden.') + '\n');
}

export async function runFacebookCommentsDelete(opts: FbCommentOpts, cmd?: Command): Promise<void> {
  const comment = numericCommentId(assertFbId(opts.comment, 'comment', '--comment'));
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({ channel, method: 'DELETE', path: `/${comment}` });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Deleted.') + '\n');
}

export async function runFacebookCommentsPrivateReply(opts: FbCommentOpts, cmd?: Command): Promise<void> {
  const comment = assertFbId(opts.comment, 'comment', '--comment');
  if (!opts.message) throw new ValidationError('--message is required.', 'MISSING_MESSAGE');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: '/{page_id}/messages',
    body: { recipient: { comment_id: comment }, message: { text: opts.message } },
  });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Sent. message_id=${res?.message_id ?? '(unknown)'}`) + '\n');
}

const CHANNEL_OPT = ['--channel <ref>', 'Channel: Page name or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)'] as const;
const COMMENT_OPT = ['--comment <id>', 'Comment id from `facebook comments list`'] as const;

/** Registers `facebook comments list|reply|hide|unhide|delete|private-reply`. */
export function registerFacebookComments(facebook: Command): void {
  const comments = facebook.command('comments').description('Read and moderate comments on Page posts');

  addExamples(
    comments,
    `
EXAMPLES:
  $ hookmyapp facebook comments list --channel ch_XXXXXXXX --post <page-id>_<post-id>
  $ hookmyapp facebook comments reply --channel ch_XXXXXXXX --comment <id> --message "Thanks!"
`,
  );

  const list = comments
    .command('list')
    .description('List the comments on a Page post, replies included')
    .option(...CHANNEL_OPT)
    .option('--post <id>', 'Post id ({pageId}_{postId})')
    .option('--limit <n>', 'Page size, 1-100 (default 25)')
    .action(async function (this: Command, opts: FbCommentsListOpts) {
      await runFacebookCommentsList(opts, this);
    });

  const reply = comments
    .command('reply')
    .description('Reply publicly under a comment')
    .option(...CHANNEL_OPT)
    .option(...COMMENT_OPT)
    .option('--message <text>', 'Reply text')
    .action(async function (this: Command, opts: FbCommentOpts) {
      await runFacebookCommentsReply(opts, this);
    });

  const hide = comments
    .command('hide')
    .description('Hide a comment (visible only to its author and their friends)')
    .option(...CHANNEL_OPT)
    .option(...COMMENT_OPT)
    .action(async function (this: Command, opts: FbCommentOpts) {
      await runFacebookCommentsHide(opts, true, this);
    });

  const unhide = comments
    .command('unhide')
    .description('Unhide a hidden comment')
    .option(...CHANNEL_OPT)
    .option(...COMMENT_OPT)
    .action(async function (this: Command, opts: FbCommentOpts) {
      await runFacebookCommentsHide(opts, false, this);
    });

  const del = comments
    .command('delete')
    .description('Delete a comment (irreversible)')
    .option(...CHANNEL_OPT)
    .option(...COMMENT_OPT)
    .action(async function (this: Command, opts: FbCommentOpts) {
      await runFacebookCommentsDelete(opts, this);
    });

  const privateReply = comments
    .command('private-reply')
    .description('Send the commenter a Messenger message (once per comment, within 7 days)')
    .option(...CHANNEL_OPT)
    .option(...COMMENT_OPT)
    .option('--message <text>', 'Message text')
    .action(async function (this: Command, opts: FbCommentOpts) {
      await runFacebookCommentsPrivateReply(opts, this);
    });

  const ex = (cmd: Command, sub: string, tail: string) =>
    addExamples(
      cmd,
      `
EXAMPLES:
  $ hookmyapp facebook comments ${sub} --channel ch_XXXXXXXX ${tail}
  $ hookmyapp facebook comments ${sub} --channel ch_XXXXXXXX ${tail} --json
`,
    );
  ex(list, 'list', '--post <page-id>_<post-id>');
  ex(reply, 'reply', '--comment <id> --message "Thanks!"');
  ex(hide, 'hide', '--comment <id>');
  ex(unhide, 'unhide', '--comment <id>');
  ex(del, 'delete', '--comment <id>');
  ex(privateReply, 'private-reply', '--comment <id> --message "Sent you a DM"');
}
