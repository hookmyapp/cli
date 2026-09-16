import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { apiClient } from '../api/client.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { assertCursor, assertFbId, pageSize } from './facebook-ids.js';

const POST_FIELDS = 'id,message,created_time,permalink_url,status_type';

export interface FbPostsOpts {
  channel?: string;
  limit?: string;
  after?: string;
}

export async function runFacebookPosts(opts: FbPostsOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const after = assertCursor(opts.after);
  const params = new URLSearchParams({ fields: POST_FIELDS, limit: pageSize(opts.limit), ...(after ? { after } : {}) });
  const res = await gatewayRequest({ channel, method: 'GET', path: `/{page_id}/posts?${params.toString()}` });
  const rows = (res?.data ?? []) as Array<Record<string, unknown>>;
  const next = res?.paging?.cursors?.after ?? null;
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify({ posts: rows, nextCursor: next }) + '\n');
    return;
  }
  for (const row of rows) {
    const text = typeof row.message === 'string' ? row.message.replace(/\s+/g, ' ').slice(0, 60) : '';
    process.stdout.write(`${String(row.id ?? '')}\t${String(row.created_time ?? '')}\t${text}\n`);
  }
  if (rows.length === 0) process.stdout.write('No posts found.\n');
  if (next) process.stdout.write(`More: --after ${next}\n`);
}

export interface FbPublishOpts {
  channel?: string;
  message?: string;
  link?: string;
  photo?: string;
  video?: string;
  reel?: string;
  description?: string;
}

function assertHttps(url: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`${flag} must be a public https URL (got: ${url}).`, 'BAD_MEDIA_URL');
  }
  if (parsed.protocol !== 'https:') throw new ValidationError(`${flag} must be a public https URL.`, 'BAD_MEDIA_URL');
  return url;
}

export async function runFacebookPublish(opts: FbPublishOpts, cmd?: Command): Promise<void> {
  const media = [opts.photo, opts.video, opts.reel].filter(Boolean);
  if (media.length > 1) throw new ValidationError('Pass only one of --photo, --video, --reel.', 'PUBLISH_ONE_KIND');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const json = Boolean(cmd && isJsonMode(cmd));

  if (opts.reel) {
    // The reel upload session (start, upload, finish) is handled server-side.
    const res = await apiClient(`/channels/${channel.id}/facebook/reels`, {
      method: 'POST',
      workspaceId: channel.workspaceId,
      body: JSON.stringify({ videoUrl: assertHttps(opts.reel, '--reel'), ...(opts.description ? { description: opts.description } : {}) }),
    });
    process.stdout.write((json ? JSON.stringify(res) : `Published reel. post_id=${res?.postId ?? '(unknown)'}`) + '\n');
    return;
  }

  let path: string;
  let body: Record<string, string>;
  if (opts.photo) {
    path = '/{page_id}/photos';
    body = { url: assertHttps(opts.photo, '--photo'), ...(opts.message ? { message: opts.message } : {}) };
  } else if (opts.video) {
    path = '/{page_id}/videos';
    body = { file_url: assertHttps(opts.video, '--video'), ...(opts.description ? { description: opts.description } : {}) };
  } else if (opts.link) {
    path = '/{page_id}/feed';
    body = { link: assertHttps(opts.link, '--link'), ...(opts.message ? { message: opts.message } : {}) };
  } else if (opts.message) {
    path = '/{page_id}/feed';
    body = { message: opts.message };
  } else {
    throw new ValidationError('Pass --message, --link, --photo, --video or --reel.', 'PUBLISH_NOTHING');
  }
  const res = await gatewayRequest({ channel, method: 'POST', path, body });
  // A video publish answers with the video id alone; the post the other
  // commands take is {pageId}_{videoId}. Feed and photo answers carry post_id.
  const rawId = typeof res?.id === 'string' ? res.id : undefined;
  const postId = res?.post_id ?? (rawId && /^\d+$/.test(rawId) ? `${channel.metaResourceId}_${rawId}` : rawId);
  process.stdout.write((json ? JSON.stringify({ ...res, post_id: postId }) : `Published. post_id=${postId ?? '(unknown)'}`) + '\n');
}

export interface FbDeletePostOpts {
  channel?: string;
  post?: string;
}

export async function runFacebookDeletePost(opts: FbDeletePostOpts, cmd?: Command): Promise<void> {
  const post = assertFbId(opts.post, 'post', '--post');
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const res = await gatewayRequest({ channel, method: 'DELETE', path: `/${post}` });
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : 'Deleted.') + '\n');
}

/** Registers `facebook posts|publish|delete-post`. */
export function registerFacebookPosts(facebook: Command): void {
  const posts = facebook
    .command('posts')
    .description('List the posts published by the Page')
    .option('--channel <ref>', 'Channel: Page name or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--limit <n>', 'Page size, 1-100 (default 25)')
    .option('--after <cursor>', 'Continue from a previous page')
    .action(async function (this: Command, opts: FbPostsOpts) {
      await runFacebookPosts(opts, this);
    });

  const publish = facebook
    .command('publish')
    .description('Publish a text, link, photo, video or reel post to the Page')
    .option('--channel <ref>', 'Channel: Page name or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--message <text>', 'Post text (alone, or with --link / --photo)')
    .option('--link <url>', 'Share a link')
    .option('--photo <url>', 'Public https URL of a JPG or PNG')
    .option('--video <url>', 'Public https URL of an MP4')
    .option('--reel <url>', 'Public https URL of an MP4 to publish as a reel')
    .option('--description <text>', 'Caption for --video or --reel')
    .action(async function (this: Command, opts: FbPublishOpts) {
      await runFacebookPublish(opts, this);
    });

  const del = facebook
    .command('delete-post')
    .description('Delete a post published by the Page (irreversible)')
    .option('--channel <ref>', 'Channel: Page name or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--post <id>', 'Post id ({pageId}_{postId})')
    .action(async function (this: Command, opts: FbDeletePostOpts) {
      await runFacebookDeletePost(opts, this);
    });

  addExamples(
    posts,
    `
EXAMPLES:
  $ hookmyapp facebook posts --channel ch_XXXXXXXX
  $ hookmyapp facebook posts --channel ch_XXXXXXXX --limit 50 --json
`,
  );
  addExamples(
    publish,
    `
EXAMPLES:
  $ hookmyapp facebook publish --channel ch_XXXXXXXX --message "We are open today"
  $ hookmyapp facebook publish --channel ch_XXXXXXXX --link https://example.com --message "New post"
  $ hookmyapp facebook publish --channel ch_XXXXXXXX --photo https://example.com/pic.jpg
  $ hookmyapp facebook publish --channel ch_XXXXXXXX --reel https://example.com/clip.mp4 --description "Behind the scenes"
`,
  );
  addExamples(
    del,
    `
EXAMPLES:
  $ hookmyapp facebook delete-post --channel ch_XXXXXXXX --post <page-id>_<post-id>
  $ hookmyapp facebook delete-post --channel ch_XXXXXXXX --post <page-id>_<post-id> --json
`,
  );
}
