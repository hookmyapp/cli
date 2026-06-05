import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ success: true })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
import { runInstagramMessagesRead } from '../instagram.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';

describe('instagram messages read', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockClear();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
  });

  it('marks a thread seen via mark_seen keyed by --to', async () => {
    await runInstagramMessagesRead({ channel: '@acme', to: '178410999' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{ig_id}/messages',
      body: { recipient: { id: '178410999' }, sender_action: 'mark_seen' },
    }));
  });

  it('requires --to', async () => {
    await expect(runInstagramMessagesRead({ channel: '@acme' })).rejects.toThrow(/required/);
  });
});
