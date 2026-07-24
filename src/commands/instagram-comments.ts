import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

const DEFAULT_GET_FIELDS = 'id,text,username,timestamp,replies{id,text,username}';
const DEFAULT_LIST_FIELDS = 'from,text,timestamp';

export interface IgCommentsListOpts {
  channel?: string;
  media?: string;
  limit?: string;
}

export async function runInstagramCommentsList(opts: IgCommentsListOpts, cmd?: Command): Promise<void> {
  if (!opts.media) throw new ValidationError('--media <ig-media-id> is required.', 'MISSING_MEDIA');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', opts.limit);
  params.set('fields', DEFAULT_LIST_FIELDS);
  const qs = params.toString();
  const res = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/${opts.media}/comments${qs ? `?${qs}` : ''}`,
  });
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }
  const rows: Array<{ id?: string; username?: string; from?: { username?: string }; text?: string }> =
    res?.data ?? [];
  if (rows.length === 0) {
    process.stdout.write('(no comments)\n');
    return;
  }
  for (const c of rows) {
    const from = c.username ?? c.from?.username ?? '(unknown)';
    process.stdout.write(`${c.id ?? '(no-id)'}\t${from}\t${c.text ?? ''}\n`);
  }
}

export interface IgCommentsGetOpts {
  channel?: string;
  fields?: string;
}

export async function runInstagramCommentsGet(
  opts: IgCommentsGetOpts,
  commentId: string,
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const params = new URLSearchParams();
  params.set('fields', opts.fields ?? DEFAULT_GET_FIELDS);
  const res = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/${commentId}?${params.toString()}`,
  });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : JSON.stringify(res, null, 2)) + '\n');
}

export interface IgCommentsReplyOpts {
  channel?: string;
  comment?: string;
  text?: string;
}

export async function runInstagramCommentsReply(opts: IgCommentsReplyOpts, cmd?: Command): Promise<void> {
  if (!opts.comment) throw new ValidationError('--comment <id> is required.', 'MISSING_COMMENT');
  if (!opts.text) throw new ValidationError('--text is required.', 'MISSING_TEXT');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: `/${opts.comment}/replies`,
    body: { message: opts.text },
  });
  process.stdout.write(
    (cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Replied. id=${res?.id ?? '(unknown)'}`) + '\n',
  );
}

export interface IgCommentsHideOpts {
  channel?: string;
  comment?: string;
  unhide?: boolean;
}

export async function runInstagramCommentsHide(opts: IgCommentsHideOpts, cmd?: Command): Promise<void> {
  if (!opts.comment) throw new ValidationError('--comment <id> is required.', 'MISSING_COMMENT');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const hide = !opts.unhide;
  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: `/${opts.comment}`,
    body: { hide },
  });
  process.stdout.write(
    (cmd && isJsonMode(cmd) ? JSON.stringify(res) : hide ? 'Hidden.' : 'Unhidden.') + '\n',
  );
}

export interface IgCommentsDeleteOpts {
  channel?: string;
}

export async function runInstagramCommentsDelete(
  opts: IgCommentsDeleteOpts,
  commentId: string,
  cmd?: Command,
): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const res = await gatewayRequest({ channel, method: 'DELETE', path: `/${commentId}` });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Deleted.') + '\n');
}

export interface IgCommentsPrivateReplyOpts {
  channel?: string;
  comment?: string;
  text?: string;
}

export async function runInstagramCommentsPrivateReply(
  opts: IgCommentsPrivateReplyOpts,
  cmd?: Command,
): Promise<void> {
  if (!opts.comment) throw new ValidationError('--comment <id> is required.', 'MISSING_COMMENT');
  if (!opts.text) throw new ValidationError('--text is required.', 'MISSING_TEXT');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: `/{ig_id}/messages`,
    body: { recipient: { comment_id: opts.comment }, message: { text: opts.text } },
  });
  process.stdout.write(
    (cmd && isJsonMode(cmd) ? JSON.stringify(res) : `Sent. message_id=${res?.message_id ?? '(unknown)'}`) + '\n',
  );
}

/** Registers `instagram comments list|get|reply|hide|delete|private-reply`. */
export function registerInstagramComments(instagram: Command): void {
  const comments = instagram.command('comments').description('Moderate Instagram comments');

  addExamples(
    comments,
    `
EXAMPLES:
  $ hookmyapp instagram comments list --channel @acme --media <ig-media-id>
  $ hookmyapp instagram comments reply --channel @acme --comment <id> --text "thanks!"
`,
  );

  const list = comments
    .command('list')
    .description('List comments on an Instagram media object')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--media <ig-media-id>', 'Instagram media id (from the inbound webhook)')
    .option('--limit <n>', 'Max comments to return')
    .action(async function (this: Command, opts: IgCommentsListOpts) {
      await runInstagramCommentsList(opts, this);
    });

  const get = comments
    .command('get')
    .description('Get a single comment with its replies')
    .argument('<comment-id>', 'Instagram comment id')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--fields <list>', `Comma-separated fields (default: ${DEFAULT_GET_FIELDS})`)
    .action(async function (this: Command, commentId: string, opts: IgCommentsGetOpts) {
      await runInstagramCommentsGet(opts, commentId, this);
    });

  const reply = comments
    .command('reply')
    .description('Reply publicly to a comment')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--comment <id>', 'Instagram comment id to reply to')
    .option('--text <text>', 'Reply text')
    .action(async function (this: Command, opts: IgCommentsReplyOpts) {
      await runInstagramCommentsReply(opts, this);
    });

  const hide = comments
    .command('hide')
    .description('Hide (or --unhide) a comment')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--comment <id>', 'Instagram comment id')
    .option('--unhide', 'Unhide instead of hide')
    .action(async function (this: Command, opts: IgCommentsHideOpts) {
      await runInstagramCommentsHide(opts, this);
    });

  const del = comments
    .command('delete')
    .description('Delete a comment')
    .argument('<comment-id>', 'Instagram comment id')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .action(async function (this: Command, commentId: string, opts: IgCommentsDeleteOpts) {
      await runInstagramCommentsDelete(opts, commentId, this);
    });

  const privateReply = comments
    .command('private-reply')
    .description('Send a private DM in response to a comment')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--comment <id>', 'Instagram comment id to privately reply to')
    .option('--text <text>', 'DM text')
    .action(async function (this: Command, opts: IgCommentsPrivateReplyOpts) {
      await runInstagramCommentsPrivateReply(opts, this);
    });

  addExamples(
    list,
    `
EXAMPLES:
  $ hookmyapp instagram comments list --channel @acme --media <ig-media-id>
  $ hookmyapp instagram comments list --channel @acme --media <ig-media-id> --limit 50
`,
  );

  addExamples(
    get,
    `
EXAMPLES:
  $ hookmyapp instagram comments get <comment-id> --channel @acme
  $ hookmyapp instagram comments get <comment-id> --channel @acme --fields id,text,username
`,
  );

  addExamples(
    reply,
    `
EXAMPLES:
  $ hookmyapp instagram comments reply --channel @acme --comment <id> --text "thanks!"
  $ hookmyapp instagram comments reply --channel @acme --comment <id> --text "thanks!" --json
`,
  );

  addExamples(
    hide,
    `
EXAMPLES:
  $ hookmyapp instagram comments hide --channel @acme --comment <id>
  $ hookmyapp instagram comments hide --channel @acme --comment <id> --unhide
`,
  );

  addExamples(
    del,
    `
EXAMPLES:
  $ hookmyapp instagram comments delete <comment-id> --channel @acme
  $ hookmyapp instagram comments delete <comment-id> --channel @acme --json
`,
  );

  addExamples(
    privateReply,
    `
EXAMPLES:
  $ hookmyapp instagram comments private-reply --channel @acme --comment <id> --text "DM!"
  $ hookmyapp instagram comments private-reply --channel @acme --comment <id> --text "DM!" --json
`,
  );
}
