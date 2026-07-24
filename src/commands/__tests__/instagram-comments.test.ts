import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ data: [], id: 'cmt.X' })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
import {
  runInstagramCommentsList,
  runInstagramCommentsGet,
  runInstagramCommentsReply,
  runInstagramCommentsHide,
  runInstagramCommentsDelete,
  runInstagramCommentsPrivateReply,
} from '../instagram-comments.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';

describe('instagram comments', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
  });

  it('list resolves the channel and GETs the media comments edge', async () => {
    await runInstagramCommentsList({ channel: '@acme', media: '178090', limit: '50' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: '/178090/comments?limit=50&fields=from%2Ctext%2Ctimestamp',
    }));
  });

  it('list sends explicit fields even without --limit (Meta default response omits from/text)', async () => {
    await runInstagramCommentsList({ channel: '@acme', media: '178090' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: '/178090/comments?fields=from%2Ctext%2Ctimestamp',
    }));
  });

  it('get includes the default fields in the path', async () => {
    await runInstagramCommentsGet({ channel: '@acme' }, 'cmt_1');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: '/cmt_1?fields=id%2Ctext%2Cusername%2Ctimestamp%2Creplies%7Bid%2Ctext%2Cusername%7D',
    }));
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
  });

  it('reply POSTs the replies edge with {message}', async () => {
    await runInstagramCommentsReply({ channel: '@acme', comment: 'cmt_1', text: 'thanks!' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/cmt_1/replies', body: { message: 'thanks!' },
    }));
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
  });

  it('hide POSTs {hide:true}', async () => {
    await runInstagramCommentsHide({ channel: '@acme', comment: 'cmt_1' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/cmt_1', body: { hide: true },
    }));
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
  });

  it('hide --unhide POSTs {hide:false}', async () => {
    await runInstagramCommentsHide({ channel: '@acme', comment: 'cmt_1', unhide: true });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/cmt_1', body: { hide: false },
    }));
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
  });

  it('delete DELETEs the comment node', async () => {
    await runInstagramCommentsDelete({ channel: '@acme' }, 'cmt_1');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'DELETE', path: '/cmt_1',
    }));
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
  });

  it('private-reply DMs the commenter via {ig_id}/messages', async () => {
    await runInstagramCommentsPrivateReply({ channel: '@acme', comment: 'cmt_1', text: 'hi' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{ig_id}/messages',
      body: { recipient: { comment_id: 'cmt_1' }, message: { text: 'hi' } },
    }));
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
  });
});
