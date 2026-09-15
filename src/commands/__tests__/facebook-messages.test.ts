import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ message_id: 'm_1' })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_fb', type: 'facebook', metaResourceId: '100000000000001', metaWabaId: null, workspaceId: 'ws_1' })) }));
import { runFacebookMessagesSend, runFacebookMessagesRead } from '../facebook.js';
import { runFacebookThreads } from '../facebook-inbox.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';

describe('facebook messages', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
  });

  it('send POSTs {page_id}/messages with recipient.id and text', async () => {
    await runFacebookMessagesSend({ channel: 'ch_fb', to: '200000000000001', text: 'hi' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('ch_fb', 'facebook');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{page_id}/messages',
      body: { recipient: { id: '200000000000001' }, message: { text: 'hi' } },
    }));
  });

  it('send --tag adds messaging_type MESSAGE_TAG', async () => {
    await runFacebookMessagesSend({ to: '200000000000001', text: 'shipped', tag: 'POST_PURCHASE_UPDATE' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { recipient: { id: '200000000000001' }, message: { text: 'shipped' }, messaging_type: 'MESSAGE_TAG', tag: 'POST_PURCHASE_UPDATE' },
    }));
  });

  it('send rejects a non-numeric --to before any call', async () => {
    await expect(runFacebookMessagesSend({ to: 'abc', text: 'hi' })).rejects.toMatchObject({ code: 'BAD_FB_ID' });
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('read POSTs sender_action mark_seen', async () => {
    await runFacebookMessagesRead({ to: '200000000000001' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{page_id}/messages', body: { recipient: { id: '200000000000001' }, sender_action: 'mark_seen' },
    }));
  });

  it('threads GETs the Page conversations with platform=messenger', async () => {
    vi.mocked(gatewayRequest).mockResolvedValueOnce({ data: [] });
    await runFacebookThreads({ limit: '10' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: '/{page_id}/conversations?platform=messenger&fields=id%2Cparticipants%2Cupdated_time%2Cunread_count%2Csnippet&limit=10',
    }));
  });

  it('threads --thread reads the thread node with a messages expansion', async () => {
    vi.mocked(gatewayRequest).mockResolvedValueOnce({ messages: { data: [] } });
    await runFacebookThreads({ thread: 't_123' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', path: '/t_123?fields=messages.limit%2825%29%7Bid%2Cmessage%2Cfrom%2Cto%2Ccreated_time%7D',
    }));
  });

  it('threads --thread rejects an id that is not t_…', async () => {
    await expect(runFacebookThreads({ thread: '123' })).rejects.toMatchObject({ code: 'BAD_FB_ID' });
  });
});
