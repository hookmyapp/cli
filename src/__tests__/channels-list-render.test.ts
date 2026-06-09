import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import { runChannelsList } from '../commands/channels.js'; // export this from channels.ts

const wa = {
  id: 'ch_WAaaaaaa', type: 'whatsapp', workspaceId: 'ws_TEST0001',
  metaWabaId: '1179', metaResourceId: '1080', connectionType: 'cloud_api',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  whatsappWabaName: 'My WABA', whatsappDisplayPhoneNumber: '+15551234567', whatsappPhoneNumberId: '1080',
  whatsappVerifiedName: 'Test', whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
};
const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramProfileName: 'Or', instagramProfilePictureUrl: null,
};

describe('runChannelsList — IG rows are visible', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('JSON mode emits both WA and IG channels in the array', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelsList({ json: true });
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toHaveLength(2);
    expect(payload.map((c: any) => c.type)).toEqual(expect.arrayContaining(['whatsapp', 'instagram']));
    outSpy.mockRestore();
  });

  it('human-table mode includes both an IG row with @handle and a WA row with +phone', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelsList({ json: false });
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('@ordvir');
    expect(combined).toContain('+15551234567');
    outSpy.mockRestore();
  });

  it('empty list → prints "channels connect" hint', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsList({ json: false });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('No channels');
    expect(combined).toContain('channels connect');
    logSpy.mockRestore();
  });
});

describe('runChannelsList — two numbers on one WABA', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  const WABA_SENTINEL = 'WABA_LIST_SENTINEL_77';
  const numberOne = {
    id: 'ch_LISTNUM1', type: 'whatsapp', workspaceId: 'ws_TEST0001',
    metaWabaId: WABA_SENTINEL, metaResourceId: WABA_SENTINEL, connectionType: 'cloud_api',
    metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
    whatsappWabaName: 'Shared WABA', whatsappDisplayPhoneNumber: '+1 555-111-1111', whatsappPhoneNumberId: 'pn_AAA',
    whatsappVerifiedName: null, whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
  };
  const numberTwo = {
    ...numberOne,
    id: 'ch_LISTNUM2', whatsappDisplayPhoneNumber: '+1 555-222-2222', whatsappPhoneNumberId: 'pn_BBB',
  };

  it('human-table mode shows both phones and never the shared WABA id', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([numberOne, numberTwo]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelsList({ json: false });
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('+1 555-111-1111');
    expect(combined).toContain('+1 555-222-2222');
    expect(combined).not.toContain(WABA_SENTINEL);
    outSpy.mockRestore();
  });
});
