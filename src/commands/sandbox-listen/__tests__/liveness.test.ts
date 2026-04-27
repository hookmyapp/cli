// sandbox-listen PostHog liveness ping tests.
//
// `cli_sandbox_listen_started` fires once on entry; `cli_sandbox_listen_liveness`
// fires every 2h with monotonically-increasing `elapsed_seconds` as a backstop
// for sessions where `cli_sandbox_listen_stopped` never fires (kill -9, OOM,
// network drop). Liveness is torn down by Ctrl-C / SIGTERM / cloudflared-exit
// — otherwise phantom pings emit for dead sessions.
//
// Uses vi.useFakeTimers() + vi.advanceTimersByTime() for deterministic
// interval assertions without waiting real time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { fakeEmit } = vi.hoisted(() => ({
  fakeEmit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../observability/posthog.js', async () => {
  const actual = await vi.importActual<typeof import('../../../observability/posthog.js')>(
    '../../../observability/posthog.js',
  );
  return { ...actual, emit: fakeEmit };
});

import { startPosthogLiveness } from '../lifecycle.js';

const TWO_HOURS_MS = 7_200_000;

describe('startPosthogLiveness', () => {
  beforeEach(() => {
    fakeEmit.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits cli_sandbox_listen_liveness after 2 hours with elapsed_seconds=7200', async () => {
    const hb = startPosthogLiveness({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: TWO_HOURS_MS,
    });
    vi.advanceTimersByTime(TWO_HOURS_MS);
    await vi.runAllTicks?.();
    await Promise.resolve();
    const calls = fakeEmit.mock.calls.filter(
      (c) => c[0] === 'cli_sandbox_listen_liveness',
    );
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toMatchObject({
      session_public_id: 'ssn_testxyz',
      elapsed_seconds: 7200,
    });
    hb.stop();
  });

  it('emits 3 pings over 6 hours with elapsed_seconds 7200/14400/21600', async () => {
    const hb = startPosthogLiveness({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: TWO_HOURS_MS,
    });
    vi.advanceTimersByTime(3 * TWO_HOURS_MS);
    await Promise.resolve();
    const calls = fakeEmit.mock.calls.filter(
      (c) => c[0] === 'cli_sandbox_listen_liveness',
    );
    expect(calls.length).toBe(3);
    const elapsed = calls.map((c) => (c[1] as { elapsed_seconds: number }).elapsed_seconds);
    expect(elapsed).toEqual([7200, 14400, 21600]);
    hb.stop();
  });

  it('stop() prevents further emissions', async () => {
    const hb = startPosthogLiveness({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: TWO_HOURS_MS,
    });
    vi.advanceTimersByTime(2 * TWO_HOURS_MS);
    await Promise.resolve();
    expect(fakeEmit).toHaveBeenCalledTimes(2);
    hb.stop();
    fakeEmit.mockClear();
    vi.advanceTimersByTime(10 * TWO_HOURS_MS);
    await Promise.resolve();
    expect(fakeEmit).not.toHaveBeenCalled();
  });

  it('carries cli_version on every ping (baseline compliance)', async () => {
    const hb = startPosthogLiveness({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
      intervalMs: TWO_HOURS_MS,
    });
    vi.advanceTimersByTime(TWO_HOURS_MS);
    await Promise.resolve();
    const call = fakeEmit.mock.calls.find(
      (c) => c[0] === 'cli_sandbox_listen_liveness',
    );
    expect(call).toBeTruthy();
    expect(typeof (call![1] as { cli_version: string }).cli_version).toBe('string');
  });

  it('uses default 2h interval when intervalMs is omitted', async () => {
    const hb = startPosthogLiveness({
      sessionId: 'ssn_testxyz',
      workspaceId: 'ws_testabc',
    });
    vi.advanceTimersByTime(TWO_HOURS_MS - 1_000);
    await Promise.resolve();
    expect(fakeEmit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(fakeEmit).toHaveBeenCalledTimes(1);
    hb.stop();
  });
});
