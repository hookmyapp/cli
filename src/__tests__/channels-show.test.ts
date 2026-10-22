import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import { runChannelsShow } from '../commands/channels.js';

const wa = {
  id: 'ch_WAaaaaaa', type: 'whatsapp', workspaceId: 'ws_TEST0001',
  metaWabaId: '1179', metaResourceId: '1080', connectionType: 'cloud_api',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  whatsappWabaName: 'My WABA', whatsappDisplayPhoneNumber: '+15551234567', whatsappPhoneNumberId: '1080',
  whatsappVerifiedName: 'Test', whatsappQualityRating: 'GREEN', whatsappQualityRatingCheckedAt: '2026-05-26T12:00:00Z',
};
const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: 'https://my.example/hook', verifyToken: null,
  instagramUsername: 'ordvir', instagramProfileName: 'Or Dvir', instagramProfilePictureUrl: null,
};

describe('runChannelsShow — type-aware detail render', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('WA channel prints +phone + whatsappWabaName + quality rating', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])  // resolveChannel list fetch
      .mockResolvedValueOnce({ ...wa, accessToken: 'EAAxxx', whatsappBusinessName: 'Test Biz' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsShow('+15551234567', { json: false });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('+15551234567');
    expect(combined).toContain('My WABA');
    expect(combined).toContain('GREEN');
    expect(combined).toContain('Test Biz');
    expect(combined).not.toContain('Instagram');
    logSpy.mockRestore();
  });

  it('IG channel prints @handle + display name + webhook URL', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce(ig);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsShow('@ordvir', { json: false });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('@ordvir');
    expect(combined).toContain('Or Dvir');
    expect(combined).toContain('https://my.example/hook');
    expect(combined).not.toContain('WABA');
    expect(combined).not.toContain('quality');
    logSpy.mockRestore();
  });

  it('WA channel prints a Groups line: available, or not available with a plain reason', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce({ ...wa, whatsappGroups: { available: true, reason: null } });
    await runChannelsShow('+15551234567', { json: false });
    expect(logSpy.mock.calls.map((c) => c.join(' '))).toContain('Groups: available');

    logSpy.mockClear();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce({ ...wa, whatsappGroups: { available: false, reason: 'whatsapp_business_app_number' } });
    await runChannelsShow('+15551234567', { json: false });
    expect(logSpy.mock.calls.map((c) => c.join(' '))).toContain('Groups: not available (whatsapp_business_app_number)');
    logSpy.mockRestore();
  });

  it('no Groups line when the backend does not report it, and none for IG', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(apiClient).mockResolvedValueOnce([wa]).mockResolvedValueOnce(wa);
    await runChannelsShow('+15551234567', { json: false });
    vi.mocked(apiClient).mockResolvedValueOnce([ig]).mockResolvedValueOnce(ig);
    await runChannelsShow('@ordvir', { json: false });
    expect(logSpy.mock.calls.map((c) => c.join(' ')).join('\n')).not.toContain('Groups');
    logSpy.mockRestore();
  });

  it('--json includes whatsappGroups', async () => {
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce({ ...wa, whatsappGroups: { available: false, reason: 'unknown' } });
    await runChannelsShow('+15551234567', { json: true });
    const printed = JSON.parse(String(w.mock.calls[0][0]));
    expect(printed.whatsappGroups).toEqual({ available: false, reason: 'unknown' });
    w.mockRestore();
  });
});
