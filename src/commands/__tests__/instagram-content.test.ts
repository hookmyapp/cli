import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn() }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
vi.mock('../../output/format.js', () => ({ isJsonMode: vi.fn(() => false) }));
import { runInstagramMediaList, runInstagramMentions, runInstagramProfile } from '../instagram-content.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';
import { isJsonMode } from '../../output/format.js';
import { ValidationError } from '../../output/error.js';

function captureStdout(): [() => string, () => void] {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
  return [() => writes.join(''), () => spy.mockRestore()];
}

describe('instagram media', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockReset();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
    vi.mocked(isJsonMode).mockReturnValue(false);
  });

  it('lists posts from the media edge and prints the id first, since that is what other commands need', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [{ id: '17999', media_type: 'IMAGE', timestamp: 'T', caption: 'hello' }] });
    const [out, restore] = captureStdout();

    await runInstagramMediaList({ channel: '@acme' });
    restore();

    expect(vi.mocked(gatewayRequest).mock.calls[0][0].path).toContain('/{ig_id}/media?');
    expect(out()).toContain('17999\tIMAGE\tT\thello');
  });

  it('expands carousel children when one post is read', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ id: '17999' });
    const [, restore] = captureStdout();

    await runInstagramMediaList({ channel: '@acme', media: '17999' });
    restore();

    expect(decodeURIComponent(vi.mocked(gatewayRequest).mock.calls[0][0].path as string)).toContain('children{');
  });

  it('clamps a limit above Meta ceiling to 100 rather than letting Meta truncate silently', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [] });
    const [, restore] = captureStdout();

    await runInstagramMediaList({ channel: '@acme', limit: '5000' });
    restore();

    expect(vi.mocked(gatewayRequest).mock.calls[0][0].path).toContain('limit=100');
  });

  it('reads tagged posts from the tags edge, the Instagram-Login mention read', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [] });
    const [, restore] = captureStdout();

    await runInstagramMediaList({ channel: '@acme', source: 'tagged' });
    restore();

    const path = vi.mocked(gatewayRequest).mock.calls[0][0].path as string;
    expect(path).toContain('/{ig_id}/tags?');
    expect(decodeURIComponent(path)).toContain('username');
  });

  it('rejects an unknown source before any gateway call', async () => {
    await expect(runInstagramMediaList({ channel: '@acme', source: 'stories' })).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric media id before any gateway call', async () => {
    await expect(runInstagramMediaList({ channel: '@acme', media: '../17999' })).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('reports the next cursor so paging is discoverable without --json', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [], paging: { cursors: { after: 'CUR9' } } });
    const [out, restore] = captureStdout();

    await runInstagramMediaList({ channel: '@acme' });
    restore();

    expect(out()).toContain('--after CUR9');
  });
});

describe('instagram mentions', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockReset();
    vi.mocked(isJsonMode).mockReturnValue(false);
  });

  it('POSTs the reply to the mentions edge, the only mention write Instagram Login has', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ id: '17846' });
    const [out, restore] = captureStdout();

    await runInstagramMentions({ channel: '@acme', media: '17999', reply: 'thanks!' });
    restore();

    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.path).toBe('/{ig_id}/mentions');
    expect(out()).toContain('Replied. id=17846');
  });

  it('includes comment_id when the mention was in a comment', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ id: '17847' });
    const [, restore] = captureStdout();

    await runInstagramMentions({ channel: '@acme', media: '17999', comment: '17888', reply: 'hi' });
    restore();

    expect((vi.mocked(gatewayRequest).mock.calls[0][0].body as Record<string, unknown>).comment_id).toBe('17888');
  });

  it('points at the tagged list when --media is missing', async () => {
    await expect(runInstagramMentions({ channel: '@acme', reply: 'hi' })).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('refuses without reply text, since this command only posts', async () => {
    await expect(runInstagramMentions({ channel: '@acme', media: '17999' })).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });
});

describe('instagram profile', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockReset();
    vi.mocked(isJsonMode).mockReturnValue(false);
  });

  it('reads the profile node and skips the quota edge unless asked', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ username: 'acme', followers_count: 12 });
    const [out, restore] = captureStdout();

    await runInstagramProfile({ channel: '@acme' });
    restore();

    expect(gatewayRequest).toHaveBeenCalledTimes(1);
    expect(out()).toContain('username\tacme');
  });

  it('also reads the publishing quota when --quota is given', async () => {
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce({ username: 'acme' })
      .mockResolvedValueOnce({ data: [{ quota_usage: 3 }] });
    const [out, restore] = captureStdout();

    await runInstagramProfile({ channel: '@acme', quota: true });
    restore();

    expect(vi.mocked(gatewayRequest).mock.calls[1][0].path).toContain('content_publishing_limit');
    expect(out()).toContain('publishing_quota_used\t3');
  });
});
