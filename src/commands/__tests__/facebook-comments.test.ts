import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ data: [], id: '1_2', message_id: 'm_1' })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_fb', type: 'facebook', metaResourceId: '100000000000001', metaWabaId: null, workspaceId: 'ws_1' })) }));
import {
  runFacebookCommentsList, runFacebookCommentsReply, runFacebookCommentsHide,
  runFacebookCommentsDelete, runFacebookCommentsPrivateReply,
} from '../facebook-comments.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';

const POST = '100000000000001_5';
const COMMENT = '5_77';

describe('facebook comments', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
  });

  it('list GETs {post}/comments with fields and filter=stream', async () => {
    await runFacebookCommentsList({ channel: 'ch_fb', post: POST, limit: '50' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('ch_fb', 'facebook');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: `/${POST}/comments?fields=id%2Cfrom%2Cmessage%2Ccreated_time%2Cis_hidden%2Cparent&filter=stream&limit=50`,
    }));
  });

  it('list rejects a post id that is not {pageId}_{postId}', async () => {
    await expect(runFacebookCommentsList({ post: '12345' })).rejects.toMatchObject({ code: 'BAD_FB_ID' });
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('reply POSTs {comment}/comments with message', async () => {
    await runFacebookCommentsReply({ comment: COMMENT, message: 'thanks' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: `/${COMMENT}/comments`, body: { message: 'thanks' } }));
  });

  it('hide and unhide POST is_hidden on the comment', async () => {
    await runFacebookCommentsHide({ comment: COMMENT }, true);
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: `/${COMMENT}`, body: { is_hidden: true } }));
    await runFacebookCommentsHide({ comment: COMMENT }, false);
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ body: { is_hidden: false } }));
  });

  it('delete DELETEs the numeric comment id (composite prefix stripped)', async () => {
    await runFacebookCommentsDelete({ comment: COMMENT });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/77' }));
  });

  it('private-reply POSTs {page_id}/messages with recipient.comment_id', async () => {
    await runFacebookCommentsPrivateReply({ comment: COMMENT, message: 'dm' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{page_id}/messages', body: { recipient: { comment_id: COMMENT }, message: { text: 'dm' } },
    }));
  });
});
