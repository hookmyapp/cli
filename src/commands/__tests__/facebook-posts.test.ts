import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ id: '100000000000001_1', post_id: '100000000000001_1' })) }));
vi.mock('../../api/client.js', () => ({ apiClient: vi.fn(async () => ({ channelId: 'ch_fb', postId: '100000000000001_9', kind: 'reel' })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_fb', type: 'facebook', metaResourceId: '100000000000001', metaWabaId: null, workspaceId: 'ws_1' })) }));
import { runFacebookPosts, runFacebookPublish, runFacebookDeletePost } from '../facebook-posts.js';
import { gatewayRequest } from '../../api/gateway.js';
import { apiClient } from '../../api/client.js';

describe('facebook posts', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(apiClient).mockClear();
  });

  it('posts GETs {page_id}/posts with the fields', async () => {
    vi.mocked(gatewayRequest).mockResolvedValueOnce({ data: [] });
    await runFacebookPosts({});
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: '/{page_id}/posts?fields=id%2Cmessage%2Ccreated_time%2Cpermalink_url%2Cstatus_type&limit=25',
    }));
  });

  it('publish --message POSTs {page_id}/feed', async () => {
    await runFacebookPublish({ message: 'hello' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/{page_id}/feed', body: { message: 'hello' } }));
  });

  it('publish --link POSTs {page_id}/feed with link and message', async () => {
    await runFacebookPublish({ link: 'https://example.com', message: 'see' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ path: '/{page_id}/feed', body: { link: 'https://example.com', message: 'see' } }));
  });

  it('publish --photo POSTs {page_id}/photos with url', async () => {
    await runFacebookPublish({ photo: 'https://example.com/a.jpg' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ path: '/{page_id}/photos', body: { url: 'https://example.com/a.jpg' } }));
  });

  it('publish --video POSTs {page_id}/videos with file_url and description', async () => {
    await runFacebookPublish({ video: 'https://example.com/a.mp4', description: 'cap' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ path: '/{page_id}/videos', body: { file_url: 'https://example.com/a.mp4', description: 'cap' } }));
  });

  it('publish --video reads the created post off the video node (the video id is not the post id)', async () => {
    vi.mocked(gatewayRequest).mockResolvedValueOnce({ id: '4242' }).mockResolvedValueOnce({ id: '4242', post_id: '7001' });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFacebookPublish({ video: 'https://example.com/a.mp4' });
    expect(gatewayRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'GET', path: '/4242?fields=post_id' }));
    expect(write).toHaveBeenCalledWith('Published. post_id=100000000000001_7001\n');
    write.mockRestore();
  });

  it('publish --reel goes through the backend reel route, not the gateway', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFacebookPublish({ reel: 'https://example.com/r.mp4', description: 'cap' });
    expect(apiClient).toHaveBeenCalledWith('/channels/ch_fb/facebook/reels', expect.objectContaining({
      method: 'POST', workspaceId: 'ws_1', body: JSON.stringify({ videoUrl: 'https://example.com/r.mp4', description: 'cap' }),
    }));
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(out.mock.calls[0][0]).toContain('100000000000001_9');
    out.mockRestore();
  });

  it('publish rejects http media and two kinds at once', async () => {
    await expect(runFacebookPublish({ photo: 'http://example.com/a.jpg' })).rejects.toMatchObject({ code: 'BAD_MEDIA_URL' });
    await expect(runFacebookPublish({ photo: 'https://a/b.jpg', video: 'https://a/b.mp4' })).rejects.toMatchObject({ code: 'PUBLISH_ONE_KIND' });
    await expect(runFacebookPublish({})).rejects.toMatchObject({ code: 'PUBLISH_NOTHING' });
  });

  it('delete-post DELETEs the post node and rejects a malformed id', async () => {
    await runFacebookDeletePost({ post: '100000000000001_1' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/100000000000001_1' }));
    await expect(runFacebookDeletePost({ post: '../x' })).rejects.toMatchObject({ code: 'BAD_FB_ID' });
  });
});
