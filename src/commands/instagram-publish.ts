import type { Command as CommandType } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError, CliError } from '../output/error.js';
import { startSpinner } from '../output/spinner.js';
import type { Channel } from '../api/channel.js';

const POLL_INTERVAL_MS = 60_000; // spec §Meta flow: poll ~1/minute per Meta guidance
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // spec §Error handling: ONE shared ~5min deadline per publish
// Meta quota rejections arrive as sanitized message text only (mapGatewayError
// strips numeric codes), so detection is message-based.
const QUOTA_RE = /publishing limit|maximum number of posts/i;

export interface IgPublishOpts {
  channel?: string;
  image?: string;
  video?: string;
  carousel?: string; // comma-separated items; a `video:` prefix marks a video child
  caption?: string;
  story?: boolean;
  reel?: boolean;
  cover?: string;
}

/** Require a well-formed public HTTPS URL. Runs before ANY gateway call. */
function requireHttpsUrl(value: string, flag: string): string {
  let parsed: URL | null = null;
  try { parsed = new URL(value); } catch { /* handled below */ }
  if (!parsed || parsed.protocol !== 'https:') {
    throw new ValidationError(`${flag} must be a public HTTPS URL (got: ${value}).`, 'PUBLISH_URL_INVALID');
  }
  return value;
}

/**
 * Poll a media container until FINISHED: immediate first check, then 1/min,
 * up to the caller's shared deadline. Exported for fake-timer tests.
 */
export async function pollContainerFinished(channel: Channel, containerId: string, deadline: number): Promise<void> {
  for (;;) {
    const res = await gatewayRequest({ channel, method: 'GET', path: `/${containerId}?fields=status_code,status` });
    const status = res?.status_code;
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') {
      const reason = typeof res?.status === 'string' ? ` (${res.status})` : '';
      throw new CliError(`Media container ${containerId} reported ${status}${reason}.`, 'PUBLISH_CONTAINER_ERROR');
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        `Media container ${containerId} not ready after 5 minutes. ` +
          `You can retry the publish step manually with creation_id=${containerId}.`,
        'PUBLISH_TIMEOUT',
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function createContainer(channel: Channel, body: Record<string, unknown>): Promise<string> {
  const res = await gatewayRequest({ channel, method: 'POST', path: `/{ig_id}/media`, body });
  if (!res?.id) throw new CliError('Meta returned no container id.', 'PUBLISH_NO_CONTAINER');
  return res.id as string;
}

/** Spec §Error handling: enrich sanitized Meta rejections (quota usage, story business-only note). */
async function enrichPublishError(err: unknown, channel: Channel, opts: IgPublishOpts): Promise<unknown> {
  if (!(err instanceof ValidationError)) return err;
  if (QUOTA_RE.test(err.message)) {
    try {
      const res = await gatewayRequest({
        channel, method: 'GET', path: '/{ig_id}/content_publishing_limit?fields=quota_usage,config',
      });
      const q = res?.data?.[0];
      if (q?.quota_usage !== undefined) {
        return new ValidationError(
          `${err.message} Publishing quota used: ${q.quota_usage}/${q.config?.quota_total ?? '?'} in the current 24h window.`,
          'PUBLISH_QUOTA',
        );
      }
    } catch { /* best-effort — fall back to the original error */ }
    return err;
  }
  if (opts.story) {
    // Creator-account rejections can't be distinguished by code (sanitized upstream),
    // so every story rejection carries the business-only hint.
    return new ValidationError(
      `${err.message} Note: Stories require a business account — creator accounts cannot publish Stories.`,
      'META_REJECTED',
    );
  }
  return err;
}

export async function runInstagramPublish(opts: IgPublishOpts, cmd?: CommandType): Promise<void> {
  const sources = [opts.image, opts.video, opts.carousel].filter(Boolean);
  if (sources.length !== 1) {
    throw new ValidationError('Pass exactly one of --image, --video, or --carousel.', 'PUBLISH_SOURCE_XOR');
  }
  if (opts.story && opts.reel) {
    throw new ValidationError('--story and --reel are mutually exclusive.', 'PUBLISH_STORY_XOR_REEL');
  }
  if ((opts.reel || opts.cover) && !opts.video) {
    throw new ValidationError('--reel and --cover require --video.', 'PUBLISH_VIDEO_ONLY_FLAG');
  }
  if (opts.story && opts.cover) {
    // cover_url is a Reels-only container field — Meta rejects it on stories.
    throw new ValidationError('--cover is not supported with --story (reels only).', 'PUBLISH_STORY_COVER');
  }
  if (opts.carousel && (opts.story || opts.reel)) {
    throw new ValidationError('--carousel cannot be combined with --story or --reel.', 'PUBLISH_CAROUSEL_FLAGS');
  }
  if (opts.image) requireHttpsUrl(opts.image, '--image');
  if (opts.video) requireHttpsUrl(opts.video, '--video');
  if (opts.cover) requireHttpsUrl(opts.cover, '--cover');
  let carouselItems: Array<{ url: string; video: boolean }> = [];
  if (opts.carousel) {
    carouselItems = opts.carousel.split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
      const video = item.startsWith('video:');
      const url = video ? item.slice('video:'.length) : item;
      return { url: requireHttpsUrl(url, '--carousel'), video };
    });
    if (carouselItems.length < 2 || carouselItems.length > 10) {
      throw new ValidationError('--carousel needs 2-10 comma-separated items.', 'PUBLISH_CAROUSEL_COUNT');
    }
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const json = Boolean(cmd && isJsonMode(cmd));
  const spinner = startSpinner('Publishing to Instagram…', json);
  const deadline = Date.now() + POLL_TIMEOUT_MS; // ONE deadline for the whole publish
  try {
    let containerId: string;
    if (opts.carousel) {
      // Create ALL children first, then poll them under the single shared deadline —
      // a 10-item carousel must never wait 10 × 5min.
      const childIds: string[] = [];
      for (const { url, video } of carouselItems) {
        childIds.push(await createContainer(channel, video
          ? { is_carousel_item: true, video_url: url, media_type: 'VIDEO' } // no reels inside carousels
          : { is_carousel_item: true, image_url: url }));
      }
      for (const childId of childIds) {
        await pollContainerFinished(channel, childId, deadline);
      }
      containerId = await createContainer(channel, {
        media_type: 'CAROUSEL',
        children: childIds.join(','), // Meta expects a comma-separated container-ID string
        ...(opts.caption && { caption: opts.caption }),
      });
    } else if (opts.video) {
      containerId = await createContainer(channel, {
        video_url: opts.video,
        // Meta feed video IS a reel under the current API; --reel is the explicit spelling.
        media_type: opts.story ? 'STORIES' : 'REELS',
        ...(opts.caption && { caption: opts.caption }),
        ...(opts.cover && { cover_url: opts.cover }),
      });
    } else {
      containerId = await createContainer(channel, {
        image_url: opts.image,
        ...(opts.caption && { caption: opts.caption }),
        ...(opts.story && { media_type: 'STORIES' }),
      });
    }
    await pollContainerFinished(channel, containerId, deadline);
    const published = await gatewayRequest({
      channel,
      method: 'POST',
      path: `/{ig_id}/media_publish`,
      body: { creation_id: containerId },
    });
    if (!published?.id) {
      throw new CliError(
        'Meta returned no media id from media_publish — publish state unknown; check the account before retrying.',
        'PUBLISH_NO_MEDIA_ID',
      );
    }
    const mediaId: string = published.id;
    // Best-effort: the publish already succeeded — a permalink failure must not fail the command.
    let permalink: string | null = null;
    try {
      const perma = await gatewayRequest({ channel, method: 'GET', path: `/${mediaId}?fields=permalink` });
      permalink = perma?.permalink ?? null;
    } catch { /* best-effort */ }
    spinner.succeed();
    process.stdout.write(
      (json
        ? JSON.stringify({ mediaId, permalink })
        : `Published. media_id=${mediaId}${permalink ? ` ${permalink}` : ''}`) + '\n',
    );
  } catch (err) {
    spinner.fail();
    throw await enrichPublishError(err, channel, opts);
  }
}

/** Registers `instagram publish`. */
export function registerInstagramPublish(instagram: CommandType): void {
  const publish = instagram
    .command('publish')
    .description('Publish an image, video (reel/story), or carousel to Instagram')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--image <url>', 'Public HTTPS image URL (JPEG)')
    .option('--video <url>', 'Public HTTPS video URL (published as a Reel unless --story)')
    .option('--carousel <items>', 'Comma-separated public HTTPS URLs (2-10 items); prefix video children with video:')
    .option('--caption <text>', 'Caption')
    .option('--story', 'Publish as a Story (business accounts only)')
    .option('--reel', 'Publish video as a Reel (explicit; already the default for --video)')
    .option('--cover <url>', 'Cover image URL for a video')
    .action(async function (this: CommandType, opts: IgPublishOpts) {
      await runInstagramPublish(opts, this);
    });

  addExamples(
    publish,
    `
EXAMPLES:
  $ hookmyapp instagram publish --channel @acme --image https://example.com/a.jpg --caption "hello"
  $ hookmyapp instagram publish --channel @acme --video https://example.com/v.mp4 --reel --cover https://example.com/c.jpg
  $ hookmyapp instagram publish --channel @acme --image https://example.com/a.jpg --story
  $ hookmyapp instagram publish --channel @acme --carousel https://x/a.jpg,video:https://x/b.mp4 --caption "set"
`,
  );
}
