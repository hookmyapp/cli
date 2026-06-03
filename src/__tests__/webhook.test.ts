import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));

// Mock output
vi.mock('../output/format.js', () => ({
  output: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: 'ws_TEST0010' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// Mock store (needed by webhook set command)
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockResolvedValue({ accessToken: 'test-token', refreshToken: 'test-refresh' }),
  saveCredentials: vi.fn().mockResolvedValue(undefined),
}));

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);

const fakeChannels = [
  {
    id: 'ch_TEST0001',
    type: 'whatsapp',
    workspaceId: 'ws_TEST0010',
    metaWabaId: 'waba-1',
    metaResourceId: 'phone-1',
    wabaName: 'Test WABA',
    displayPhoneNumber: '+1 234 567 890',
    phoneNumberId: 'phone-1',
    phoneVerifiedName: null,
    qualityRating: null,
    qualityRatingCheckedAt: null,
    connectionType: 'cloud_api',
    metaConnected: true,
    forwardingEnabled: true,
    webhookUrl: null,
    verifyToken: null,
  },
];

// Mock global fetch for webhook set command's direct fetch call
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('webhook commands', () => {
  let runChannelWebhookShow: typeof import('../commands/webhook.js').runChannelWebhookShow;
  let runChannelWebhookSet: typeof import('../commands/webhook.js').runChannelWebhookSet;
  let runChannelWebhookClear: typeof import('../commands/webhook.js').runChannelWebhookClear;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockConsoleError.mockClear();
    mockFetch.mockReset();

    const mod = await import('../commands/webhook.js');
    runChannelWebhookShow = mod.runChannelWebhookShow;
    runChannelWebhookSet = mod.runChannelWebhookSet;
    runChannelWebhookClear = mod.runChannelWebhookClear;
  });

  it('showWebhook calls apiClient /webhook-config/:channelId', async () => {
    const config = { webhookUrl: 'https://example.com/hook', verifyToken: 'abc123' };
    // First call: resolveChannel -> /meta/channels
    // Second call: /webhook-config/:id
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels)
      .mockResolvedValueOnce(config);

    await runChannelWebhookShow('ch_TEST0001');

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/webhook-config/ch_TEST0001');
    expect(mockedOutput).toHaveBeenCalledWith(config, expect.objectContaining({}));
  });

  it('setWebhook calls apiClient to configure webhook for channel', async () => {
    // resolveChannel -> /meta/channels
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels)
      .mockResolvedValueOnce({ updated: true }); // PUT webhook-config

    // Mock fetch for the direct check call (returns 200 = existing config)
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Suppress console.log
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runChannelWebhookSet(
      'ch_TEST0001',
      { url: 'https://example.com/hook', verifyToken: 'secret' },
    );

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/webhook-config/ch_TEST0001', {
      method: 'PUT',
      body: JSON.stringify({ webhookUrl: 'https://example.com/hook', verifyToken: 'secret' }),
    });
  });

  it('setWebhook throws ValidationError when --url flag is missing', async () => {
    await expect(
      runChannelWebhookSet('ch_TEST0001', {}),
    ).rejects.toThrow('--url is required');
  });

  it('clearWebhook DELETEs /webhook-config/:channelId', async () => {
    // resolveChannel -> /meta/channels, then DELETE /webhook-config/:id (204)
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels)
      .mockResolvedValueOnce(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runChannelWebhookClear('ch_TEST0001');

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/webhook-config/ch_TEST0001', { method: 'DELETE' });
    expect(mockedOutput).toHaveBeenCalledWith({ status: 'cleared' }, expect.objectContaining({ kind: 'mutation' }));
  });
});

describe('token command', () => {
  let runChannelToken: typeof import('../commands/token.js').runChannelToken;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();

    const mod = await import('../commands/token.js');
    runChannelToken = mod.runChannelToken;
  });

  it('token command calls apiClient /meta/channels/:id/token and writes a gateway key summary', async () => {
    // resolveChannel -> /meta/channels, then /meta/channels/:id/token (gateway summary)
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels)
      .mockResolvedValueOnce({ hasActiveKey: true, keyPrefix: 'hmp_live_a1b2', keySuffix: 'ZZZZ' });
    const mockWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runChannelToken('ch_TEST0001');

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_TEST0001/token');
    const written = mockWrite.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('key present: hmp_live_a1b2…ZZZZ');
    expect(written).toContain('hookmyapp keys create ch_TEST0001');
    expect(written).not.toContain('accessToken');
    mockWrite.mockRestore();
  });
});
