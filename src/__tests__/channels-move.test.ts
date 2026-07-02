import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEAM0001'),
}));
vi.mock('../output/format.js', () => ({ output: vi.fn() }));

import { apiClient } from '../api/client.js';
import { runChannelsMove } from '../commands/channels.js';

const wa = {
  id: 'ch_WAaaaaaa', type: 'whatsapp', workspaceId: 'ws_TEAM0001',
  metaWabaId: '1179', metaResourceId: '1080', connectionType: 'cloud_api',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  whatsappWabaName: 'My WABA', whatsappDisplayPhoneNumber: '+15551234567', whatsappPhoneNumberId: '1080',
  whatsappVerifiedName: 'Test', whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
};

// A customer workspace (kind='customer') is a valid cross-kind move target —
// resolveWorkspace() is called with no kind restriction, so it matches by name
// across both team and customer workspaces.
const customer = { id: 'ws_CUST0001', name: 'Acme Cafe', role: 'admin', kind: 'customer', workosOrganizationId: 'org_x' };

describe('channels move — cross-kind (team → customer)', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('POSTs /channels/:id/move with the resolved customer target and no --kind', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])            // resolveChannel → GET /meta/channels
      .mockResolvedValueOnce([customer])      // resolveWorkspace → GET /workspaces
      .mockResolvedValueOnce({ ok: true });   // POST /channels/:id/move
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runChannelsMove('ch_WAaaaaaa', 'Acme Cafe');

    const moveCall = vi.mocked(apiClient).mock.calls[2];
    expect(moveCall[0]).toBe('/channels/ch_WAaaaaaa/move');
    expect(JSON.parse((moveCall[1] as { body: string }).body)).toEqual({
      targetWorkspacePublicId: 'ws_CUST0001',
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Acme Cafe'));
    logSpy.mockRestore();
  });
});
