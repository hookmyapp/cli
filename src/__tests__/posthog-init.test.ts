// Phase 125 Plan 02 Task 1 — PostHog lazy-init contract tests.
//
// Mirrors `sentry-init.test.ts` shape verbatim so failures land with the same
// debug ergonomics. Asserts:
//
//   1. `initPostHogLazy()` is a NO-OP when `HOOKMYAPP_TELEMETRY=off`.
//   2. `initPostHogLazy()` is a NO-OP when persisted `telemetry: 'off'`.
//   3. `initPostHogLazy()` is a NO-OP when no token is baked (dev build).
//   4. `initPostHogLazy()` returns a real PostHog client when both telemetry
//      is enabled AND a token is present, with `flushAt: 1, flushInterval: 0`
//      (short-lived-process pattern from RESEARCH §Pattern 1).
//   5. Subsequent calls reuse the same instance — no re-init.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factory must be declared BEFORE the dynamic import; vitest hoists
// vi.mock calls above any non-import statement at the top of the file.
const fakePostHogCtor = vi.fn();
const fakeCapture = vi.fn();
const fakeAlias = vi.fn();
const fakeShutdown = vi.fn().mockResolvedValue(undefined);
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
  __isInitializedForTests as isPostHogInitialized,
} from '../observability/posthog.js';
import {
  setPersistedTelemetry,
  unsetPersistedTelemetry,
} from '../observability/telemetry.js';

describe('PostHog lazy init', () => {
  const origToken = process.env.HOOKMYAPP_POSTHOG_TOKEN;
  const origHost = process.env.HOOKMYAPP_POSTHOG_HOST;
  const origTelemetry = process.env.HOOKMYAPP_TELEMETRY;

  beforeEach(() => {
    resetPostHog();
    fakePostHogCtor.mockReset();
    fakeCapture.mockReset();
    fakeAlias.mockReset();
    fakeShutdown.mockClear();
    fakeOn.mockReset();
    delete process.env.HOOKMYAPP_TELEMETRY;
    delete process.env.HOOKMYAPP_POSTHOG_TOKEN;
    delete process.env.HOOKMYAPP_POSTHOG_HOST;
    unsetPersistedTelemetry();
  });

  afterEach(() => {
    if (origToken === undefined) delete process.env.HOOKMYAPP_POSTHOG_TOKEN;
    else process.env.HOOKMYAPP_POSTHOG_TOKEN = origToken;
    if (origHost === undefined) delete process.env.HOOKMYAPP_POSTHOG_HOST;
    else process.env.HOOKMYAPP_POSTHOG_HOST = origHost;
    if (origTelemetry === undefined) delete process.env.HOOKMYAPP_TELEMETRY;
    else process.env.HOOKMYAPP_TELEMETRY = origTelemetry;
    resetPostHog();
  });

  it('returns null when HOOKMYAPP_POSTHOG_TOKEN is empty (dev build)', async () => {
    process.env.HOOKMYAPP_POSTHOG_TOKEN = '';
    const client = await initPostHogLazy();
    expect(client).toBeNull();
    expect(isPostHogInitialized()).toBe(false);
    expect(fakePostHogCtor).not.toHaveBeenCalled();
  });

  it('returns null when HOOKMYAPP_POSTHOG_TOKEN is unset', async () => {
    const client = await initPostHogLazy();
    expect(client).toBeNull();
    expect(fakePostHogCtor).not.toHaveBeenCalled();
  });

  it('returns null when HOOKMYAPP_TELEMETRY=off (regardless of token)', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_real_token';
    const client = await initPostHogLazy();
    expect(client).toBeNull();
    expect(fakePostHogCtor).not.toHaveBeenCalled();
  });

  it('returns null when persisted telemetry=off (config set)', async () => {
    setPersistedTelemetry('off');
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_real_token';
    const client = await initPostHogLazy();
    expect(client).toBeNull();
    expect(fakePostHogCtor).not.toHaveBeenCalled();
  });

  it('returns a PostHog client with flushAt:1 + flushInterval:0 when telemetry on + token present', async () => {
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_real_token';
    const client = await initPostHogLazy();
    expect(client).not.toBeNull();
    expect(isPostHogInitialized()).toBe(true);
    expect(fakePostHogCtor).toHaveBeenCalledTimes(1);
    const [tokenArg, optsArg] = fakePostHogCtor.mock.calls[0];
    expect(tokenArg).toBe('phc_real_token');
    expect(optsArg).toMatchObject({
      flushAt: 1,
      flushInterval: 0,
      host: 'https://us.i.posthog.com', // default
    });
  });

  it('honors HOOKMYAPP_POSTHOG_HOST override', async () => {
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_real_token';
    process.env.HOOKMYAPP_POSTHOG_HOST = 'https://eu.i.posthog.com';
    await initPostHogLazy();
    expect(fakePostHogCtor.mock.calls[0][1]).toMatchObject({
      host: 'https://eu.i.posthog.com',
    });
  });

  it('is idempotent — second call reuses the same instance', async () => {
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_real_token';
    const a = await initPostHogLazy();
    const b = await initPostHogLazy();
    expect(a).toBe(b);
    expect(fakePostHogCtor).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on the no-op path too (no re-attempt to load posthog-node)', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    await initPostHogLazy();
    await initPostHogLazy();
    await initPostHogLazy();
    expect(fakePostHogCtor).not.toHaveBeenCalled();
  });
});
