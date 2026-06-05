import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ message_id: 'mid.X' })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
import { runInstagramMessagesSend } from '../instagram.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';

describe('instagram messages send', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
  });

  it('builds the Messenger send body from --to/--text', async () => {
    await runInstagramMessagesSend({ channel: '@acme', to: '178410999', text: 'hey' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{ig_id}/messages',
      body: { recipient: { id: '178410999' }, message: { text: 'hey' } },
    }));
  });

  it('rejects --text + --body together', async () => {
    await expect(runInstagramMessagesSend({ channel: '@a', to: '1', text: 'x', body: '{}' })).rejects.toThrow(/not both/);
  });

  it('accepts -d/--data as an alias for --body', async () => {
    await runInstagramMessagesSend({ channel: '@acme', data: '{"recipient":{"id":"178410999"},"message":{"text":"hey"}}' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { recipient: { id: '178410999' }, message: { text: 'hey' } },
    }));
  });
});
