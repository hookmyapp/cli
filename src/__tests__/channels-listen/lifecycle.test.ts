import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
}));

import { apiClient } from '../../api/client.js';
import { startChannelHeartbeat } from '../../commands/channels-listen/lifecycle.js';
import { ApiError } from '../../output/error.js';

const mockedApiClient = vi.mocked(apiClient);

describe('startChannelHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedApiClient.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('When backend returns 204 every tick', () => {
    it('then heartbeat fires every interval and never invokes callbacks', async () => {
      mockedApiClient.mockResolvedValue(undefined);
      const onError = vi.fn();
      const onTerminal = vi.fn();

      const handle = startChannelHeartbeat({
        channelId: 'ch_AAAAAAAA',
        workspaceId: 'ws_TEST0001',
        onError,
        onTerminal,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(mockedApiClient).toHaveBeenCalledTimes(2);
      expect(onError).not.toHaveBeenCalled();
      expect(onTerminal).not.toHaveBeenCalled();
      expect(mockedApiClient).toHaveBeenCalledWith(
        '/channels/ch_AAAAAAAA/tunnel/heartbeat',
        { method: 'POST', workspaceId: 'ws_TEST0001' },
      );

      handle.stop();
    });
  });

  describe('When backend returns 410 (CHANNEL_TUNNEL_RECLAIMED) on a heartbeat', () => {
    it('then invokes onTerminal with the userMessage and stops the loop', async () => {
      const reclaimErr = new ApiError(
        "This channel's destination was changed. The CLI listener has been stopped.",
        410,
      );
      mockedApiClient.mockRejectedValueOnce(reclaimErr);
      const onError = vi.fn();
      const onTerminal = vi.fn();

      const handle = startChannelHeartbeat({
        channelId: 'ch_AAAAAAAA',
        workspaceId: 'ws_TEST0001',
        onError,
        onTerminal,
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(onTerminal).toHaveBeenCalledOnce();
      expect(onTerminal).toHaveBeenCalledWith({
        code: expect.any(String),
        userMessage:
          "This channel's destination was changed. The CLI listener has been stopped.",
      });
      expect(onError).not.toHaveBeenCalled();

      mockedApiClient.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockedApiClient).toHaveBeenCalledOnce();

      handle.stop();
    });
  });

  describe('When backend returns 5xx', () => {
    it('then tolerates one failure and invokes onError on the second consecutive', async () => {
      mockedApiClient.mockRejectedValue(new Error('500 Internal Server Error'));
      const onError = vi.fn();
      const onTerminal = vi.fn();

      const handle = startChannelHeartbeat({
        channelId: 'ch_AAAAAAAA',
        workspaceId: 'ws_TEST0001',
        onError,
        onTerminal,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onError).toHaveBeenCalledOnce();
      expect(onTerminal).not.toHaveBeenCalled();

      handle.stop();
    });
  });

  describe('When a 5xx blip is followed by a success', () => {
    it('then the consecutive-failure counter resets', async () => {
      mockedApiClient.mockRejectedValueOnce(new Error('500 blip'));
      mockedApiClient.mockResolvedValueOnce(undefined);
      mockedApiClient.mockRejectedValueOnce(new Error('500 again'));
      const onError = vi.fn();
      const onTerminal = vi.fn();

      const handle = startChannelHeartbeat({
        channelId: 'ch_AAAAAAAA',
        workspaceId: 'ws_TEST0001',
        onError,
        onTerminal,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(onError).not.toHaveBeenCalled();
      expect(onTerminal).not.toHaveBeenCalled();

      handle.stop();
    });
  });

  describe('When stop() is called', () => {
    it('then the loop ceases firing', async () => {
      mockedApiClient.mockResolvedValue(undefined);
      const handle = startChannelHeartbeat({
        channelId: 'ch_AAAAAAAA',
        workspaceId: 'ws_TEST0001',
        onError: vi.fn(),
        onTerminal: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(30_000);
      handle.stop();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockedApiClient).toHaveBeenCalledOnce();
    });
  });
});
