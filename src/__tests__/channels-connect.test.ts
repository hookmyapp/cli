import { describe, it, expect, beforeEach, vi } from 'vitest';

// IMPORTANT: vi.mock replaces the ENTIRE module surface. runChannelsConnect
// imports BOTH `apiClient` AND `forceTokenRefresh` from '../api/client.js'
// (the latter is called once at the top of the function — see B6 Step 3 +
// the legacy assertion in channels.test.ts:222). Both must be in the mock
// or Vitest crashes with "forceTokenRefresh is not a function" before any
// assertion runs.
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));
vi.mock('open', () => ({ default: vi.fn() }));
// Mock the polling helper so integration tests complete cleanly without
// running the real 2s poll loop. Routing-only assertions don't need this
// (buildConnectStartRequest is pure); integration tests use it.
//
// IMPORTANT: pollForNewChannels lives in its OWN module
// (src/commands/channels-connect-poll.ts) — vi.mock'ing the channels.js
// module wouldn't work because runChannelsConnect's internal call binds
// to the local function reference, not the re-exported one. ESM module
// boundaries are the only way to intercept.
vi.mock('../commands/channels-connect-poll.js', () => ({
  pollForNewChannels: vi.fn(),
}));

import {
  runChannelsConnect,
  buildConnectStartRequest,
} from '../commands/channels.js';
import { pollForNewChannels } from '../commands/channels-connect-poll.js';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { select } from '@inquirer/prompts';
import open from 'open';
import { ValidationError } from '../output/error.js';

describe('buildConnectStartRequest — pure routing helper', () => {
  it('whatsapp → /meta/oauth/start with redirectPath body', () => {
    expect(buildConnectStartRequest('whatsapp')).toEqual({
      path: '/meta/oauth/start',
      body: JSON.stringify({ redirectPath: '/cli/callback' }),
    });
  });

  it('instagram → /instagram/oauth/start with { flow: "cli" } body', () => {
    expect(buildConnectStartRequest('instagram')).toEqual({
      path: '/instagram/oauth/start',
      body: JSON.stringify({ flow: 'cli' }),
    });
  });
});

describe('runChannelsConnect — integration (D2)', () => {
  // The integration tests below mock pollForNewChannels to resolve
  // immediately with a stub channel. This lets the full runChannelsConnect
  // complete cleanly (no .catch(() => {}) swallowing) so any unexpected
  // exception bubbles up and fails the test rather than being silently
  // dropped. Routing-only assertions live in buildConnectStartRequest
  // tests above; these integration tests assert the full call ordering.
  beforeEach(() => {
    vi.mocked(select).mockReset();
    vi.mocked(apiClient).mockReset();
    // Reset call history (not the implementation) so toHaveBeenCalledOnce()
    // in the WhatsApp routing test is isolated from any other test in the
    // file that triggers runChannelsConnect. mockClear keeps the
    // mockResolvedValue(undefined) implementation from the top-level mock
    // factory; mockReset would wipe the implementation too and the
    // resolved-undefined would have to be re-asserted here.
    vi.mocked(forceTokenRefresh).mockClear();
    vi.mocked(pollForNewChannels).mockResolvedValue([
      {
        id: 'ch_NEW_WA', type: 'whatsapp', workspaceId: 'ws_TEST0001',
        metaWabaId: '1', metaResourceId: '1', connectionType: 'cloud_api',
        metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
        whatsappWabaName: null, whatsappDisplayPhoneNumber: null, whatsappPhoneNumberId: null,
        whatsappVerifiedName: null, whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
      } as any,
    ]);
    process.stdout.isTTY = true;
  });

  it('explicit whatsapp: forceTokenRefresh runs, then snapshot, then POSTs to /meta/oauth/start with redirectPath body', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])  // 1. snapshot BEFORE open
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example/wa', codeChallenge: 'c' }); // 2. OAuth
    await runChannelsConnect({ type: 'whatsapp' });
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    expect(vi.mocked(forceTokenRefresh)).toHaveBeenCalledOnce(); // legacy assertion preserved
    const calls = vi.mocked(apiClient).mock.calls;
    expect(calls[0][0]).toBe('/meta/channels');
    expect(calls[1][0]).toBe('/meta/oauth/start');
    expect(calls[1][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ redirectPath: '/cli/callback' }),
    });
  });

  it('explicit instagram: snapshots first, then POSTs to /instagram/oauth/start with { flow: "cli" } body', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ redirectUrl: 'https://meta.example/ig' });
    await runChannelsConnect({ type: 'instagram' });
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    const calls = vi.mocked(apiClient).mock.calls;
    expect(calls[0][0]).toBe('/meta/channels');
    expect(calls[1][0]).toBe('/instagram/oauth/start');
    expect(calls[1][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ flow: 'cli' }),
    });
  });

  it('bare (no type) in TTY → prompts via @inquirer/select', async () => {
    vi.mocked(select).mockResolvedValueOnce('instagram');
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ redirectUrl: 'https://meta.example/ig' });
    await runChannelsConnect({});
    expect(vi.mocked(select)).toHaveBeenCalled();
  });

  it('bare (no type) in non-TTY → ValidationError CONNECT_TYPE_REQUIRED (D5 courier)', async () => {
    // Only the interactive type-picker hard-requires a TTY now. With --type set
    // a non-TTY shell proceeds to the headless URL courier (see
    // connect-courier.test.ts); bare (no type) still errors.
    process.stdout.isTTY = false;
    await expect(runChannelsConnect({})).rejects.toThrow(ValidationError);
    await expect(runChannelsConnect({})).rejects.toThrow(
      /Specify a channel type|non-interactive shell/,
    );
  });
});

describe('runChannelsConnect — reports all new channels by type (D7)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(forceTokenRefresh).mockClear();
    vi.mocked(pollForNewChannels).mockResolvedValue([
      {
        id: 'ch_NEW_WA', type: 'whatsapp', workspaceId: 'ws_TEST0001',
        metaWabaId: '1', metaResourceId: '1', connectionType: 'cloud_api',
        metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
        whatsappWabaName: null, whatsappDisplayPhoneNumber: '+15551234567', whatsappPhoneNumberId: '1',
        whatsappVerifiedName: null, whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
      } as any,
      {
        id: 'ch_NEW_IG', type: 'instagram', workspaceId: 'ws_TEST0001',
        metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
        metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
        instagramUsername: 'newhandle', instagramProfileName: 'New', instagramProfilePictureUrl: null,
      } as any,
    ]);
    process.stdout.isTTY = true;
  });

  it('prints both WhatsApp +phone and Instagram @handle in the post-connect summary', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])                                                      // snapshot
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example', codeChallenge: 'c' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsConnect({ type: 'whatsapp' });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('WhatsApp');
    expect(combined).toContain('+15551234567');
    expect(combined).toContain('Instagram');
    expect(combined).toContain('@newhandle');
    logSpy.mockRestore();
  });
});

describe('runChannelsConnect — names the newly-added 2nd number on an existing WABA (D7)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(forceTokenRefresh).mockClear();
    // The poll returns ONLY the new number (new ch_ id), as a 2nd number on
    // an existing WABA: same whatsappWabaName, distinct display phone + id.
    vi.mocked(pollForNewChannels).mockResolvedValue([
      {
        id: 'ch_NUM2NEW', type: 'whatsapp', workspaceId: 'ws_TEST0001',
        metaWabaId: 'WABA_CONNECT_SENTINEL', metaResourceId: 'WABA_CONNECT_SENTINEL',
        connectionType: 'embedded_signup', metaConnected: true, forwardingEnabled: true,
        webhookUrl: null, verifyToken: null,
        whatsappWabaName: 'Shared WABA', whatsappDisplayPhoneNumber: '+1 555-777-7777',
        whatsappPhoneNumberId: 'pn_NEW2', whatsappVerifiedName: null,
        whatsappQualityRating: null, whatsappQualityRatingCheckedAt: null,
      } as any,
    ]);
    process.stdout.isTTY = true;
  });

  it('prints the new number display phone and its new ch_ id, not the WABA id', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])                                              // snapshot
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example', codeChallenge: 'c' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsConnect({ type: 'whatsapp' });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('+1 555-777-7777');
    expect(combined).toContain('ch_NUM2NEW');
    expect(combined).not.toContain('WABA_CONNECT_SENTINEL');
    logSpy.mockRestore();
  });
});

describe('runChannelsConnect — --print-url', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(open).mockClear();
    vi.mocked(forceTokenRefresh).mockClear();
    vi.mocked(pollForNewChannels).mockResolvedValue([
      {
        id: 'ch_NEW_IG', type: 'instagram', workspaceId: 'ws_TEST0001',
        metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
        metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
        instagramUsername: 'newhandle', instagramProfileName: 'New', instagramProfilePictureUrl: null,
      } as any,
    ]);
    process.stdout.isTTY = true;
  });

  it('prints the OAuth URL and does NOT launch the browser', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ redirectUrl: 'https://meta.example/ig-print' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsConnect({ type: 'instagram', printUrl: true });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('https://meta.example/ig-print');
    expect(vi.mocked(open)).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
