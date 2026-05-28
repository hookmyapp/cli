import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('../output/format.js', () => ({ output: vi.fn() }));

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import {
  runChannelsDisconnect,
  runChannelsEnable,
  runChannelsDisable,
} from '../commands/channels.js';

const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('channels toggle actions accept IG channels', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('disconnect on @ordvir POSTs to /meta/channels/ch_IGaaaaaa/disconnect', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])           // resolveChannel
      .mockResolvedValueOnce({ ok: true });  // disconnect endpoint
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsDisconnect('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/disconnect');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Instagram @ordvir'));
    logSpy.mockRestore();
  });

  it('enable on @ordvir POSTs to /meta/channels/ch_IGaaaaaa/enable', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ forwardingEnabled: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsEnable('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/enable');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Instagram @ordvir'));
    logSpy.mockRestore();
  });

  it('disable on @ordvir POSTs to /meta/channels/ch_IGaaaaaa/disable', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ forwardingEnabled: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsDisable('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/disable');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Instagram @ordvir'));
    logSpy.mockRestore();
  });

  it('enable --json emits {channelId, forwardingEnabled:true}, no human text', async () => {
    vi.mocked(output).mockReset();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ forwardingEnabled: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsEnable('@ordvir', true);
    expect(output).toHaveBeenCalledWith(
      { channelId: 'ch_IGaaaaaa', forwardingEnabled: true },
      { human: false },
    );
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('disable --json emits {channelId, forwardingEnabled:false}, no human text', async () => {
    vi.mocked(output).mockReset();
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ forwardingEnabled: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsDisable('@ordvir', true);
    expect(output).toHaveBeenCalledWith(
      { channelId: 'ch_IGaaaaaa', forwardingEnabled: false },
      { human: false },
    );
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
