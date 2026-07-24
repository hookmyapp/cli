import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn() }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
vi.mock('../../output/format.js', () => ({ isJsonMode: vi.fn(() => false) }));
import { Command } from 'commander';
import { runInstagramPublish, pollContainerFinished, registerInstagramPublish } from '../instagram-publish.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';
import { isJsonMode } from '../../output/format.js';
import { ValidationError } from '../../output/error.js';

const channel = { id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' } as never;

/** Capture process.stdout.write; returns [getOutput, restore]. */
function captureStdout(): [() => string, () => void] {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
  return [() => writes.join(''), () => spy.mockRestore()];
}

describe('instagram publish', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockReset();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
    vi.mocked(isJsonMode).mockReturnValue(false);
  });

  it('image: container create → poll FINISHED → media_publish → permalink', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })                     // POST /{ig_id}/media
      .mockResolvedValueOnce({ status_code: 'FINISHED' })          // GET /cont_1?fields=status_code,status
      .mockResolvedValueOnce({ id: 'media_1' })                    // POST /{ig_id}/media_publish
      .mockResolvedValueOnce({ permalink: 'https://www.instagram.com/p/X/' });
    await runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg', caption: 'hi' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
    expect(gatewayRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'POST', path: '/{ig_id}/media', body: { image_url: 'https://example.com/a.jpg', caption: 'hi' },
    }));
    expect(gatewayRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET', path: '/cont_1?fields=status_code,status',
    }));
    expect(gatewayRequest).toHaveBeenNthCalledWith(3, expect.objectContaining({
      method: 'POST', path: '/{ig_id}/media_publish', body: { creation_id: 'cont_1' },
    }));
    expect(gatewayRequest).toHaveBeenNthCalledWith(4, expect.objectContaining({
      method: 'GET', path: '/media_1?fields=permalink',
    }));
  });

  it('image --story sets media_type STORIES', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })
      .mockResolvedValueOnce({ id: 'media_1' })
      .mockResolvedValueOnce({ permalink: 'https://www.instagram.com/stories/x/1/' });
    await runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg', story: true });
    expect(gatewayRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      body: { image_url: 'https://example.com/a.jpg', media_type: 'STORIES' },
    }));
  });

  it('video defaults to REELS and passes cover_url', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })
      .mockResolvedValueOnce({ id: 'media_1' })
      .mockResolvedValueOnce({ permalink: 'https://www.instagram.com/reel/X/' });
    await runInstagramPublish({ channel: '@acme', video: 'https://example.com/v.mp4', cover: 'https://example.com/c.jpg' });
    expect(gatewayRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      body: { video_url: 'https://example.com/v.mp4', media_type: 'REELS', cover_url: 'https://example.com/c.jpg' },
    }));
  });

  it('carousel: children created first then polled, parent gets comma-joined children string', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'child_1' })                    // child 1 create (image)
      .mockResolvedValueOnce({ id: 'child_2' })                    // child 2 create (video: prefix)
      .mockResolvedValueOnce({ status_code: 'FINISHED' })          // child 1 poll
      .mockResolvedValueOnce({ status_code: 'FINISHED' })          // child 2 poll
      .mockResolvedValueOnce({ id: 'parent_1' })                   // parent create
      .mockResolvedValueOnce({ status_code: 'FINISHED' })          // parent poll
      .mockResolvedValueOnce({ id: 'media_1' })                    // media_publish
      .mockResolvedValueOnce({ permalink: 'https://www.instagram.com/p/C/' });
    await runInstagramPublish({ channel: '@acme', carousel: 'https://x/a.jpg,video:https://x/b.mp4', caption: 'c' });
    expect(gatewayRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      body: { is_carousel_item: true, image_url: 'https://x/a.jpg' },
    }));
    expect(gatewayRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      body: { is_carousel_item: true, video_url: 'https://x/b.mp4', media_type: 'VIDEO' },
    }));
    expect(gatewayRequest).toHaveBeenNthCalledWith(5, expect.objectContaining({
      body: { media_type: 'CAROUSEL', children: 'child_1,child_2', caption: 'c' },
    }));
  });

  it('rejects zero or multiple sources and --story with --reel', async () => {
    await expect(runInstagramPublish({ channel: '@acme' })).rejects.toThrow(/exactly one/i);
    await expect(runInstagramPublish({ channel: '@acme', image: 'https://x/a.jpg', video: 'https://x/v.mp4' })).rejects.toThrow(/exactly one/i);
    await expect(runInstagramPublish({ channel: '@acme', video: 'https://x/v.mp4', story: true, reel: true })).rejects.toThrow(/mutually exclusive/i);
    await expect(runInstagramPublish({ channel: '@acme', image: 'https://x/a.jpg', cover: 'https://x/c.jpg' })).rejects.toThrow(/--cover/i);
    await expect(runInstagramPublish({ channel: '@acme', video: 'https://x/v.mp4', story: true, cover: 'https://x/c.jpg' })).rejects.toThrow(/--cover is not supported with --story/i);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS or malformed media URLs before any gateway call', async () => {
    await expect(runInstagramPublish({ channel: '@acme', image: 'http://x/a.jpg' })).rejects.toThrow(/https/i);
    await expect(runInstagramPublish({ channel: '@acme', image: 'not a url' })).rejects.toThrow(/https/i);
    await expect(runInstagramPublish({ channel: '@acme', video: '/tmp/v.mp4' })).rejects.toThrow(/https/i);
    await expect(runInstagramPublish({ channel: '@acme', carousel: 'https://x/a.jpg,http://x/b.jpg' })).rejects.toThrow(/https/i);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('container ERROR fails naming the container id AND Meta status text', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'ERROR', status: 'Video format not supported' });
    const promise = runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg' });
    await expect(promise).rejects.toThrow(/cont_1/);
    await expect(promise).rejects.toThrow(/Video format not supported/);
  });

  it('missing media id from media_publish fails without a permalink GET', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })
      .mockResolvedValueOnce({});                                  // media_publish returned no id
    await expect(
      runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg' }),
    ).rejects.toThrow(/media id/i);
    expect(gatewayRequest).toHaveBeenCalledTimes(3);               // no GET /(unknown)
  });

  it('--json prints the {mediaId, permalink} contract', async () => {
    vi.mocked(isJsonMode).mockReturnValue(true);
    const [out, restore] = captureStdout();
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })
      .mockResolvedValueOnce({ id: 'media_1' })
      .mockResolvedValueOnce({ permalink: 'https://www.instagram.com/p/X/' });
    await runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg' }, {} as Command);
    restore();
    expect(JSON.parse(out())).toEqual({ mediaId: 'media_1', permalink: 'https://www.instagram.com/p/X/' });
  });

  it('permalink fetch is best-effort: failure still reports success with permalink null', async () => {
    vi.mocked(isJsonMode).mockReturnValue(true);
    const [out, restore] = captureStdout();
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })
      .mockResolvedValueOnce({ id: 'media_1' })
      .mockRejectedValueOnce(new ValidationError('permalink unavailable', 'META_REJECTED'));
    await runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg' }, {} as Command);
    restore();
    expect(JSON.parse(out())).toEqual({ mediaId: 'media_1', permalink: null });
  });

  it('quota rejection is enriched with live content_publishing_limit usage', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'cont_1' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })
      .mockRejectedValueOnce(new ValidationError('The user has reached the maximum number of posts allowed (publishing limit).', 'META_REJECTED'))
      .mockResolvedValueOnce({ data: [{ quota_usage: 48, config: { quota_total: 50 } }] });
    await expect(
      runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg' }),
    ).rejects.toThrow(/48\/50/);
    expect(gatewayRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'GET', path: '/{ig_id}/content_publishing_limit?fields=quota_usage,config',
    }));
  });

  it('story rejection carries the business-only note', async () => {
    vi.mocked(gatewayRequest)
      .mockRejectedValueOnce(new ValidationError('Not authorized to publish stories', 'META_REJECTED'));
    await expect(
      runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg', story: true }),
    ).rejects.toThrow(/business account/i);
  });

  it('a non-Meta ValidationError on a story publish is rethrown verbatim (no business-only note)', async () => {
    const err = new ValidationError('Cannot fill {ig_id} for channel ch_x.', 'PLACEHOLDER_UNRESOLVED');
    vi.mocked(gatewayRequest).mockRejectedValueOnce(err);
    await expect(
      runInstagramPublish({ channel: '@acme', image: 'https://example.com/a.jpg', story: true }),
    ).rejects.toBe(err);
  });

  it('registers the publish subcommand with examples', () => {
    const instagram = new Command('instagram');
    registerInstagramPublish(instagram);
    const publish = instagram.commands.find((c) => c.name() === 'publish');
    expect(publish).toBeDefined();
    expect(publish!.helpInformation()).toContain('EXAMPLES:');
  });
});

describe('pollContainerFinished timing', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(gatewayRequest).mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('checks immediately, then once per minute until FINISHED', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' });
    const promise = pollContainerFinished(channel, 'cont_1', Date.now() + 5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);       // immediate first check
    await vi.advanceTimersByTimeAsync(60_000);  // check 2
    await vi.advanceTimersByTimeAsync(60_000);  // check 3 → FINISHED
    await promise;
    expect(gatewayRequest).toHaveBeenCalledTimes(3);
  });

  it('gives up at the shared deadline (~6 checks in 5 minutes) naming the container id', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ status_code: 'IN_PROGRESS' });
    const promise = pollContainerFinished(channel, 'cont_1', Date.now() + 5 * 60 * 1000);
    promise.catch(() => {});
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).rejects.toThrow(/cont_1/);
    expect(gatewayRequest).toHaveBeenCalledTimes(6);  // t=0,60,…,300 — never ~151 calls
  });

  it('carousel shares ONE 5-minute deadline across children and parent', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ id: 'child_1' })
      .mockResolvedValueOnce({ id: 'child_2' })
      .mockResolvedValue({ status_code: 'IN_PROGRESS' });          // nothing ever finishes
    const promise = runInstagramPublish({ channel: '@acme', carousel: 'https://x/a.jpg,https://x/b.jpg' });
    promise.catch(() => {});
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).rejects.toThrow(/child_1/);              // total wait bounded at ~5min, not 5min × containers
  });
});
