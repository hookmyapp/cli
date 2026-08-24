import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

// Same shape guard the insights command applies: a Graph media id is numeric, so
// anything else could smuggle path segments into the route.
const IG_MEDIA_ID_RE = /^\d+$/;
const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count';
const MEDIA_CHILDREN = 'children{id,media_type,media_url,thumbnail_url}';
const MENTIONED_MEDIA_FIELDS =
  'id,caption,media_type,media_url,permalink,timestamp,username,comments_count';
const PROFILE_FIELDS =
  'id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count';

// No --source for stories or tagged posts: both need a Facebook User access
// token and pages_read_engagement, and Meta states the Instagram-Login setup
// "cannot access ads or tagging". Every channel we connect is Instagram-Login.

/** Meta caps a page at 100 and silently truncates a larger ask, which would read
 *  as the end of the list. */
function pageSize(limit?: string): string {
  if (limit === undefined) return '25';
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError(`--limit must be a whole number of 1 or more (got: ${limit}).`, 'BAD_LIMIT');
  }
  return String(Math.min(n, 100));
}

function assertMediaId(id: string, flag: string): void {
  if (!IG_MEDIA_ID_RE.test(id)) {
    throw new ValidationError(`${flag} must be a numeric Instagram media id (got: ${id}).`, 'BAD_MEDIA_ID');
  }
}

/** One row per post — id first, because the id is what every other command wants. */
function printMediaRows(rows: Array<Record<string, unknown>>): void {
  for (const row of rows) {
    const caption = typeof row.caption === 'string' ? row.caption.replace(/\s+/g, ' ').slice(0, 60) : '';
    process.stdout.write(
      `${String(row.id ?? '')}\t${String(row.media_type ?? '')}\t${String(row.timestamp ?? '')}\t${caption}\n`,
    );
  }
  if (rows.length === 0) process.stdout.write('No posts found.\n');
}

export interface IgMediaOpts {
  channel?: string;
  media?: string;
  limit?: string;
  after?: string;
}

export async function runInstagramMediaList(opts: IgMediaOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');

  if (opts.media) {
    assertMediaId(opts.media, '--media');
    const res = await gatewayRequest({
      channel,
      method: 'GET',
      path: `/${opts.media}?fields=${encodeURIComponent(`${MEDIA_FIELDS},${MEDIA_CHILDREN}`)}`,
    });
    process.stdout.write(
      (cmd && isJsonMode(cmd) ? JSON.stringify(res) : JSON.stringify(res, null, 2)) + '\n',
    );
    return;
  }

  const params = new URLSearchParams({
    fields: MEDIA_FIELDS,
    limit: pageSize(opts.limit),
    ...(opts.after ? { after: opts.after } : {}),
  });
  const res = await gatewayRequest({ channel, method: 'GET', path: `/{ig_id}/media?${params.toString()}` });
  const rows = (res?.data ?? []) as Array<Record<string, unknown>>;

  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(
      JSON.stringify({ media: rows, nextCursor: res?.paging?.cursors?.after ?? null }) + '\n',
    );
    return;
  }
  printMediaRows(rows);
  const next = res?.paging?.cursors?.after;
  if (next) process.stdout.write(`More: --after ${next}\n`);
}

export interface IgMentionsOpts {
  channel?: string;
  comment?: string;
  media?: string;
  reply?: string;
}

/**
 * Instagram has no endpoint that lists past mentions — `/{ig}/mentions` is
 * POST-only (it creates the reply). A mention arrives on the `mentions`
 * webhook carrying the comment id or media id, and that id is read back as a
 * field expansion on the IG-User node.
 */
export async function runInstagramMentions(opts: IgMentionsOpts, cmd?: Command): Promise<void> {
  const hasComment = Boolean(opts.comment);
  const hasMedia = Boolean(opts.media);
  if (!hasComment && !hasMedia) {
    throw new ValidationError(
      'Pass --comment or --media from the mentions webhook. Instagram has no endpoint that lists past mentions.',
      'MENTION_NO_TARGET',
    );
  }
  if (hasComment) assertMediaId(opts.comment!, '--comment');
  if (hasMedia) assertMediaId(opts.media!, '--media');
  if (opts.reply && !hasMedia) {
    throw new ValidationError(
      'Replying to a mention needs --media from the webhook, alongside --comment.',
      'MENTION_REPLY_NEEDS_MEDIA',
    );
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');

  const expansion = hasComment
    ? `mentioned_comment.comment_id(${opts.comment}){id,text,timestamp,username,like_count}`
    : `mentioned_media.media_id(${opts.media}){${MENTIONED_MEDIA_FIELDS}}`;
  const node = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/{ig_id}?fields=${encodeURIComponent(expansion)}`,
  });
  const mention = (hasComment ? node?.mentioned_comment : node?.mentioned_media) ?? null;

  let replyId: string | null = null;
  if (opts.reply) {
    const posted = await gatewayRequest({
      channel,
      method: 'POST',
      path: '/{ig_id}/mentions',
      body: {
        media_id: opts.media,
        ...(hasComment ? { comment_id: opts.comment } : {}),
        message: opts.reply,
      },
    });
    replyId = posted?.id ?? null;
  }

  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify({ target: hasComment ? 'comment' : 'media', mention, replyId }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(mention, null, 2) + '\n');
  if (replyId) process.stdout.write(`Replied. id=${replyId}\n`);
}

export interface IgProfileOpts {
  channel?: string;
  quota?: boolean;
}

export async function runInstagramProfile(opts: IgProfileOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const profile = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/{ig_id}?fields=${encodeURIComponent(PROFILE_FIELDS)}`,
  });

  let publishingLimit: unknown = null;
  if (opts.quota) {
    const quota = await gatewayRequest({
      channel,
      method: 'GET',
      path: '/{ig_id}/content_publishing_limit?fields=config,quota_usage',
    });
    publishingLimit = quota?.data?.[0] ?? null;
  }

  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify({ profile, publishingLimit }) + '\n');
    return;
  }
  for (const [key, value] of Object.entries(profile ?? {})) {
    process.stdout.write(`${key}\t${String(value ?? '')}\n`);
  }
  if (opts.quota) {
    const used = (publishingLimit as { quota_usage?: number } | null)?.quota_usage;
    process.stdout.write(`publishing_quota_used\t${used ?? '(unknown)'}\n`);
  }
}

/** Registers `instagram media|mentions|profile`. */
export function registerInstagramContent(instagram: Command): void {
  const media = instagram
    .command('media')
    .description('List your published posts, and get the media ids other commands need')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--media <id>', 'Read one post instead of a list, including carousel items')
    .option('--limit <n>', 'Page size, 1-100 (default 25)')
    .option('--after <cursor>', 'Continue from a previous page')
    .action(async function (this: Command, opts: IgMediaOpts) {
      await runInstagramMediaList(opts, this);
    });

  addExamples(
    media,
    `
EXAMPLES:
  $ hookmyapp instagram media --channel @acme
  $ hookmyapp instagram media --channel @acme --media <ig-media-id>
  $ hookmyapp instagram media --channel @acme --json
`,
  );

  const mentions = instagram
    .command('mentions')
    .description('Read a post or comment you were @mentioned in, and optionally reply')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--comment <id>', 'Comment id from the mentions webhook')
    .option('--media <id>', 'Media id from the mentions webhook (required to reply)')
    .option('--reply <text>', 'Post this reply as a comment from your account')
    .action(async function (this: Command, opts: IgMentionsOpts) {
      await runInstagramMentions(opts, this);
    });

  addExamples(
    mentions,
    `
EXAMPLES:
  $ hookmyapp instagram mentions --channel @acme --media <media-id>
  $ hookmyapp instagram mentions --channel @acme --comment <comment-id> --media <media-id>
  $ hookmyapp instagram mentions --channel @acme --media <media-id> --reply "thanks for the shout-out"

Instagram has no endpoint that lists past mentions. The ids come from the
mentions webhook — subscribe to it to catch them as they happen.
`,
  );

  const profile = instagram
    .command('profile')
    .description('Read your account profile, and optionally your publishing quota')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--quota', 'Also report how much of today’s publishing quota is used')
    .action(async function (this: Command, opts: IgProfileOpts) {
      await runInstagramProfile(opts, this);
    });

  addExamples(
    profile,
    `
EXAMPLES:
  $ hookmyapp instagram profile --channel @acme
  $ hookmyapp instagram profile --channel @acme --quota --json
`,
  );
}
