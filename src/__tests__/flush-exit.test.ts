// Phase 125 Plan 02 Task 1 — flushAndExit covers BOTH Sentry + PostHog.
//
// CONTEXT.md §125-02 must_haves: process exit awaits `posthog.shutdown(2000)`
// + `Sentry.flush(2000)` in parallel via Promise.allSettled — neither
// vendor's failure can block the other.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fakePostHogCtor = vi.fn();
const fakeShutdown = vi.fn().mockResolvedValue(undefined);
const fakeCapture = vi.fn();
const fakeAlias = vi.fn();
const fakeOn = vi.fn();
class FakePostHog {
  constructor(token: string, opts: Record<string, unknown>) {
    fakePostHogCtor(token, opts);
  }
  capture = fakeCapture;
  alias = fakeAlias;
  shutdown = fakeShutdown;
  on = fakeOn;
}
vi.mock('posthog-node', () => ({ PostHog: FakePostHog }));

import {
  initPostHogLazy,
  __resetForTests as resetPostHog,
} from '../observability/posthog.js';
import {
  flushAndExit,
  __resetForTests as resetSentry,
} from '../observability/sentry.js';
import { unsetPersistedTelemetry } from '../observability/telemetry.js';

describe('flushAndExit awaits PostHog AND Sentry in parallel', () => {
  beforeEach(() => {
    resetPostHog();
    resetSentry();
    fakeShutdown.mockClear();
    fakePostHogCtor.mockReset();
    delete process.env.HOOKMYAPP_TELEMETRY;
    delete process.env.HOOKMYAPP_POSTHOG_TOKEN;
    unsetPersistedTelemetry();
  });

  afterEach(() => {
    resetPostHog();
    resetSentry();
  });

  it('calls posthog.shutdown(2000) when PostHog client is initialised', async () => {
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_test';
    await initPostHogLazy(); // initialise
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as never);
    try {
      await expect(flushAndExit(0)).rejects.toThrow('__test_exit_0__');
      expect(fakeShutdown).toHaveBeenCalledTimes(1);
      expect(fakeShutdown).toHaveBeenCalledWith(2000);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('still exits cleanly when PostHog shutdown rejects (parallel + allSettled)', async () => {
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_test';
    fakeShutdown.mockRejectedValueOnce(new Error('posthog drop'));
    await initPostHogLazy();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as never);
    try {
      await expect(flushAndExit(2)).rejects.toThrow('__test_exit_2__');
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('does not call posthog.shutdown when PostHog was never initialised (telemetry off path)', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_test';
    await initPostHogLazy(); // returns null — no client
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as never);
    try {
      await expect(flushAndExit(0)).rejects.toThrow('__test_exit_0__');
      expect(fakeShutdown).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
