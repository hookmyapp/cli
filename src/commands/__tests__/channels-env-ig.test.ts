import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../api/client.js';
import { runChannelEnv } from '../env.js';

const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('runChannelEnv on IG channel — backend returns INSTAGRAM_* keys (D5)', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('emits INSTAGRAM_* env keys verbatim from /meta/channels/:id/env', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])  // resolveChannel list fetch
      .mockResolvedValueOnce({
        channelType: 'instagram',
        values: {
          INSTAGRAM_ACCESS_TOKEN: 'EAAxxx',
          INSTAGRAM_ACCOUNT_ID: '17841',
          INSTAGRAM_API_URL: 'https://graph.facebook.com/v25.0',
        },
        defaults: { PORT: '3000', VERIFY_TOKEN: 'vt_xxx' },
      });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelEnv('@ordvir', {});
    const out = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('INSTAGRAM_ACCESS_TOKEN=EAAxxx');
    expect(out).toContain('INSTAGRAM_ACCOUNT_ID=17841');
    expect(out).toContain('INSTAGRAM_API_URL=https://graph.facebook.com/v25.0');
    expect(out).toContain('PORT=3000');
    expect(out).toContain('VERIFY_TOKEN=vt_xxx');
    outSpy.mockRestore();
  });
});
