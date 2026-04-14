import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// Mock api client (for heartbeat calls)
vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { apiClient } from '../../api/client.js';
import {
  spawnCloudflared,
  startHeartbeat,
  gracefulShutdown,
} from '../../commands/sandbox-listen/lifecycle.js';

const mockedSpawn = vi.mocked(spawn);
const mockedApiClient = vi.mocked(apiClient);

function makeFakeChild(): any {
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe('spawnCloudflared', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('spawns binary with correct args and NO --url flag (Pitfall 1)', () => {
    const child = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(child);

    spawnCloudflared({ binaryPath: '/tmp/cloudflared', token: 'tok-abc' });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [bin, args] = mockedSpawn.mock.calls[0];
    expect(bin).toBe('/tmp/cloudflared');
    expect(args).toContain('tunnel');
    expect(args).toContain('run');
    expect(args).toContain('--no-autoupdate');
    expect(args).toContain('--token');
    expect(args).toContain('tok-abc');
    // CRITICAL (Pitfall 1): must NEVER include --url in token-mode spawn args
    expect(args).not.toContain('--url');
  });

  it('sets TUNNEL_ORIGIN_CERT=/dev/null in child env (Pitfall 10)', () => {
    const child = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(child);

    spawnCloudflared({ binaryPath: '/tmp/cf', token: 'tok-abc' });

    const [, , spawnOpts] = mockedSpawn.mock.calls[0] as any[];
    expect(spawnOpts?.env?.TUNNEL_ORIGIN_CERT).toBe('/dev/null');
  });
});

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedApiClient.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls apiClient /tunnel/heartbeat on interval', async () => {
    mockedApiClient.mockResolvedValue(undefined);
    const hb = startHeartbeat({
      sessionId: 'sess-xyz',
      intervalMs: 1_000,
      onError: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockedApiClient).toHaveBeenCalledWith(
      '/sandbox/sessions/sess-xyz/tunnel/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockedApiClient).toHaveBeenCalledTimes(2);

    hb.stop();
  });

  it('tolerates a single transient failure (onError not called on first error)', async () => {
    mockedApiClient
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();

    const hb = startHeartbeat({ sessionId: 's1', intervalMs: 1_000, onError });

    await vi.advanceTimersByTimeAsync(1_000);
    // Let the rejected promise settle.
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(onError).not.toHaveBeenCalled();
    hb.stop();
  });

  it('calls onError on second consecutive failure', async () => {
    mockedApiClient.mockRejectedValue(new Error('still down'));
    const onError = vi.fn();

    const hb = startHeartbeat({ sessionId: 's1', intervalMs: 1_000, onError });

    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    hb.stop();
  });
});

describe('gracefulShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls hooks in order: stopHeartbeat → proxyClose → callBackendStop → SIGTERM', async () => {
    const calls: string[] = [];
    const child = makeFakeChild();
    const shutdownP = gracefulShutdown({
      cloudflaredChild: child,
      stopHeartbeat: () => calls.push('stopHeartbeat'),
      proxyClose: async () => {
        calls.push('proxyClose');
      },
      callBackendStop: async () => {
        calls.push('callBackendStop');
      },
    });

    // Allow microtasks to run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Child emits exit so SIGKILL timer doesn't fire.
    child.emit('exit', 0);
    await shutdownP;

    expect(calls).toEqual(['stopHeartbeat', 'proxyClose', 'callBackendStop']);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not block on backend stop failure (try/catch internally)', async () => {
    const child = makeFakeChild();
    const shutdownP = gracefulShutdown({
      cloudflaredChild: child,
      stopHeartbeat: () => {},
      proxyClose: async () => {},
      callBackendStop: async () => {
        throw new Error('backend down');
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    child.emit('exit', 0);
    await expect(shutdownP).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('SIGKILLs after 5s if child does not exit', async () => {
    const child = makeFakeChild();
    const shutdownP = gracefulShutdown({
      cloudflaredChild: child,
      stopHeartbeat: () => {},
      proxyClose: async () => {},
      callBackendStop: async () => {},
    });

    // Flush the prep microtasks.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Advance 5s — child never emits 'exit'.
    await vi.advanceTimersByTimeAsync(5_000);
    await shutdownP;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
