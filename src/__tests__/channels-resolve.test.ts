import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import { resolveChannel } from '../commands/channels.js';

const wa = {
  id: 'ch_WAaaaaaa',
  type: 'whatsapp',
  workspaceId: 'ws_TEST0001',
  metaWabaId: '1179',
  metaResourceId: '1080',
  connectionType: 'cloud_api',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: null,
  verifyToken: null,
  wabaName: 'My WABA',
  displayPhoneNumber: '+15551234567',
  phoneNumberId: '1080',
  phoneVerifiedName: 'Test',
  qualityRating: null,
  qualityRatingCheckedAt: null,
};
const ig = {
  id: 'ch_IGaaaaaa',
  type: 'instagram',
  workspaceId: 'ws_TEST0001',
  metaWabaId: '',
  metaResourceId: '17841',
  connectionType: 'instagram_login',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: null,
  verifyToken: null,
  instagramUsername: 'ordvir',
  instagramName: 'Or',
  instagramProfilePictureUrl: null,
};

describe('resolveChannel — shape-detected positional', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('+phone narrows to WA channel by displayPhoneNumber', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const out = await resolveChannel('+15551234567');
    expect(out.id).toBe('ch_WAaaaaaa');
  });

  it('@handle narrows to IG channel by instagramUsername', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const out = await resolveChannel('@ordvir');
    expect(out.id).toBe('ch_IGaaaaaa');
  });

  it('ch_X exact match', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const out = await resolveChannel('ch_IGaaaaaa');
    expect(out.id).toBe('ch_IGaaaaaa');
  });

  it('ssn_X → ValidationError (wrong family)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    await expect(resolveChannel('ssn_abcdefgh')).rejects.toThrow(
      /sandbox session publicId.*channels commands take ch_X/,
    );
  });

  it('no match → CliError with available identifiers listed', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    await expect(resolveChannel('@nobody')).rejects.toThrow(/No channel matches @nobody/);
  });
});
