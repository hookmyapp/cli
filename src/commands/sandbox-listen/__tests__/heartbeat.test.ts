// Phase 125 Plan 02 Task 2 — sandbox-listen PostHog heartbeat tests.
//
// CONTEXT.md §5 + RESEARCH §Pattern 9: `cli_sandbox_listen_started` fires
// once on entry; `cli_sandbox_listen_heartbeat` fires every 5 minutes with
// monotonically-increasing `elapsed_minutes`. Heartbeat is torn down by
// Ctrl-C / SIGTERM / cloudflared-exit / markShuttingDown (RESEARCH §Pitfall
// 6 — otherwise phantom heartbeats emit for dead sessions).
//
// Uses vi.useFakeTimers() + vi.advanceTimersByTime() for deterministic
// 5-minute interval assertions without waiting real time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the posthog emit() export so we can assert emissions without loading
// the real posthog-node SDK. `vi.hoisted` keeps the mock factory hoist-safe
// — plain top-level const would fail with "Cannot access X before init"
// because vi.mock hoists above all other statements.
const { fakeEmit } = vi.hoisted(() => ({
  fakeEmit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../observability/posthog.js', async () => {
  const actual = await vi.importActual<typeof import('../../../observability/posthog.js')>(
    '../../../observability/posthog.js',
  );
  return { ...actual, emit: fakeEmit };
});

import { startPosthogHeartbeat } from '../lifecycle.js';

describe('startPosthogHeartbeat', () => {
  beforeEach(() => {
    fakeEmit.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits cli_sandbox_listen_heartbeat after 5 minutes with elapsed_minutes=5', async () => {
    const hb = startPosthogHeartbeat({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: 300_000,
    });
    vi.advanceTimersByTime(300_000);
    // Allow any queued microtasks to settle (emit is async).
    await vi.runAllTicks?.();
    await Promise.resolve();
    const hbCalls = fakeEmit.mock.calls.filter(
      (c) => c[0] === 'cli_sandbox_listen_heartbeat',
    );
    expect(hbCalls.length).toBe(1);
    expect(hbCalls[0][1]).toMatchObject({
      session_public_id: 'ssn_testxyz',
      elapsed_minutes: 5,
    });
    hb.stop();
  });

  it('emits 5 heartbeats over 25 minutes with elapsed_minutes 5..25', async () => {
    const hb = startPosthogHeartbeat({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: 300_000,
    });
    vi.advanceTimersByTime(25 * 60_000);
    await Promise.resolve();
    const hbCalls = fakeEmit.mock.calls.filter(
      (c) => c[0] === 'cli_sandbox_listen_heartbeat',
    );
    expect(hbCalls.length).toBe(5);
    const elapsed = hbCalls.map((c) => (c[1] as { elapsed_minutes: number }).elapsed_minutes);
    expect(elapsed).toEqual([5, 10, 15, 20, 25]);
    hb.stop();
  });

  it('stop() prevents further emissions', async () => {
    const hb = startPosthogHeartbeat({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: 300_000,
    });
    vi.advanceTimersByTime(10 * 60_000);
    await Promise.resolve();
    expect(fakeEmit).toHaveBeenCalledTimes(2);
    hb.stop();
    fakeEmit.mockClear();
    vi.advanceTimersByTime(60 * 60_000);
    await Promise.resolve();
    expect(fakeEmit).not.toHaveBeenCalled();
  });

  it('carries cli_version on every heartbeat (baseline compliance)', async () => {
    const hb = startPosthogHeartbeat({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: 300_000,
    });
    vi.advanceTimersByTime(300_000);
    await Promise.resolve();
    const hbCall = fakeEmit.mock.calls.find(
      (c) => c[0] === 'cli_sandbox_listen_heartbeat',
    );
    expect(hbCall).toBeTruthy();
    expect(typeof (hbCall![1] as { cli_version: string }).cli_version).toBe('string');
  });

  it('uses default 5-min interval when intervalMs is omitted', async () => {
    const hb = startPosthogHeartbeat({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
    });
    vi.advanceTimersByTime(299_000);
    await Promise.resolve();
    expect(fakeEmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(fakeEmit).toHaveBeenCalledTimes(1);
    hb.stop();
  });
});
