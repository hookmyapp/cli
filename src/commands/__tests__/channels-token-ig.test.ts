import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../api/client.js';
import { runChannelToken } from '../token.js';

const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('runChannelToken on IG channel — emits backend token', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('GETs /meta/channels/ch_IGaaaaaa/token and prints the accessToken', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])  // resolveChannel
      .mockResolvedValueOnce({ accessToken: 'EAAxxx' });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelToken('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/token');
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('EAAxxx');
    outSpy.mockRestore();
  });
});
