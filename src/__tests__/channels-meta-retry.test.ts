import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('../output/format.js', () => ({ output: vi.fn() }));

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { runChannelsMetaRetry } from '../commands/channels.js';
import { ValidationError } from '../output/error.js';

const ch = {
  id: 'ch_WAaaaaaa', type: 'whatsapp', workspaceId: 'ws_TEST0001',
  metaResourceId: '123', metaConnected: true, forwardingEnabled: true,
  displayPhoneNumber: '+972500000000', wabaName: 'Test WABA',
  phoneNumberId: '1080996501762047', qualityRating: 'GREEN',
  metaWabaId: '123', connectionType: 'whatsapp', webhookUrl: null, verifyToken: null,
};

function parsedBody(callIndex: number): unknown {
  const body = vi.mocked(apiClient).mock.calls[callIndex]?.[1]?.body;
  return JSON.parse(body as string);
}

describe('channels meta-retry', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('off POSTs to meta-retry with stringified { enabled: false }', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ch])                    // resolveChannel
      .mockResolvedValueOnce({ metaRetryDisabled: true }); // meta-retry endpoint
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsMetaRetry('off', 'ch_WAaaaaaa');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_WAaaaaaa/meta-retry');
    expect(vi.mocked(apiClient).mock.calls[1][1]).toMatchObject({
      method: 'POST',
      workspaceId: 'ws_TEST0001',
    });
    expect(parsedBody(1)).toEqual({ enabled: false });
    logSpy.mockRestore();
  });

  it('on POSTs to meta-retry with stringified { enabled: true }', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ch])
      .mockResolvedValueOnce({ metaRetryDisabled: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsMetaRetry('on', 'ch_WAaaaaaa');
    expect(parsedBody(1)).toEqual({ enabled: true });
    logSpy.mockRestore();
  });

  it('--json emits the raw result, no human text', async () => {
    vi.mocked(output).mockReset();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ch])
      .mockResolvedValueOnce({ metaRetryDisabled: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsMetaRetry('off', 'ch_WAaaaaaa', true);
    expect(output).toHaveBeenCalledWith({ metaRetryDisabled: true }, { human: false });
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('invalid mode rejects with INVALID_META_RETRY_MODE and never hits the network', async () => {
    await expect(runChannelsMetaRetry('sometimes', 'ch_WAaaaaaa')).rejects.toSatisfy(
      (e: unknown) => e instanceof ValidationError && e.code === 'INVALID_META_RETRY_MODE',
    );
    expect(apiClient).not.toHaveBeenCalled();
  });
});
