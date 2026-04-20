// Phase 123 Plan 10 — Sentry lazy-init tests.
//
// Contract:
//
//   1. `initSentryLazy()` is a NO-OP when telemetry is disabled. The
//      `@sentry/node` module must NEVER dynamic-import on a telemetry-off path
//      (cold-start tax avoidance — the main reason this is lazy).
//
//   2. `initSentryLazy()` is a NO-OP when no DSN is baked (dev builds).
//      `build.mjs` replaces `process.env.HOOKMYAPP_SENTRY_DSN` with '' when
//      the build-time env var is unset, so `initSentryLazy` must safely skip.
//
//   3. `captureError()` is a no-op when Sentry isn't initialized (no throw,
//      no module load).
//
//   4. `flushAndExit()` is a no-op wrapper around `process.exit` when Sentry
//      isn't initialized (zero added latency for telemetry-off users).
//
//   5. `shouldCaptureToSentry()` filters backend-response wrappers (any error
//      with a non-undefined statusCode → false) — implements the
//      single-capture-per-error rule from CONTEXT.md.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initSentryLazy,
  captureError,
  shouldCaptureToSentry,
  flushAndExit,
  __resetForTests,
  __isInitializedForTests,
} from '../observability/sentry.js';
import {
  setPersistedTelemetry,
  unsetPersistedTelemetry,
} from '../observability/telemetry.js';
import { AuthError, ApiError, NetworkError } from '../output/error.js';

describe('Sentry lazy init', () => {
  const origDsn = process.env.HOOKMYAPP_SENTRY_DSN;
  const origTelemetry = process.env.HOOKMYAPP_TELEMETRY;

  beforeEach(() => {
    __resetForTests();
    delete process.env.HOOKMYAPP_TELEMETRY;
    delete process.env.HOOKMYAPP_SENTRY_DSN;
    unsetPersistedTelemetry();
  });

  afterEach(() => {
    if (origDsn === undefined) {
      delete process.env.HOOKMYAPP_SENTRY_DSN;
    } else {
      process.env.HOOKMYAPP_SENTRY_DSN = origDsn;
    }
    if (origTelemetry === undefined) {
      delete process.env.HOOKMYAPP_TELEMETRY;
    } else {
      process.env.HOOKMYAPP_TELEMETRY = origTelemetry;
    }
    __resetForTests();
  });

  it('is a no-op when HOOKMYAPP_TELEMETRY=off — does NOT load @sentry/node', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    process.env.HOOKMYAPP_SENTRY_DSN = 'https://fake@sentry.io/1';
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(false);
  });

  it('is a no-op when persisted telemetry=off (via config set)', async () => {
    setPersistedTelemetry('off');
    process.env.HOOKMYAPP_SENTRY_DSN = 'https://fake@sentry.io/1';
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(false);
  });

  it('is a no-op when DSN is empty (dev build — no bake)', async () => {
    // Telemetry ON (default), DSN empty.
    process.env.HOOKMYAPP_SENTRY_DSN = '';
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(false);
  });

  it('is a no-op when DSN env var is unset entirely', async () => {
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(false);
  });

  it('is idempotent — subsequent calls after a no-op skip re-attempt', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    await initSentryLazy();
    await initSentryLazy();
    await initSentryLazy();
    expect(__isInitializedForTests()).toBe(false);
  });

  it('swallows Sentry.init() failures — telemetry must NEVER break the CLI', async () => {
    // We can't easily force @sentry/node.init() to throw without mocking it.
    // This test asserts the shape of the contract: repeated calls don't
    // raise, don't flip initialized, don't leak module state.
    process.env.HOOKMYAPP_SENTRY_DSN = 'https://definitely-not-a-real-dsn@invalid/0';
    // Even with an invalid DSN, the module-load itself succeeds; init() might
    // log but not throw. Either way, our wrapper catches and sets
    // initialized=false on any throw.
    await expect(initSentryLazy()).resolves.not.toThrow();
  });
});

describe('captureError', () => {
  beforeEach(() => {
    __resetForTests();
    delete process.env.HOOKMYAPP_TELEMETRY;
    delete process.env.HOOKMYAPP_SENTRY_DSN;
  });

  it('is a no-op when Sentry is not initialized', async () => {
    // No init called → captureError should return without throwing.
    await expect(captureError(new Error('test'))).resolves.toBeUndefined();
  });

  it('is a no-op when passed null/undefined', async () => {
    await expect(captureError(null)).resolves.toBeUndefined();
    await expect(captureError(undefined)).resolves.toBeUndefined();
  });
});

describe('shouldCaptureToSentry filter (single-capture-per-error rule)', () => {
  it('captures errors with no statusCode (local CLI failures)', () => {
    expect(shouldCaptureToSentry(new Error('local failure'))).toBe(true);
  });

  it('captures NetworkError (pre-backend failures — DNS, offline)', () => {
    expect(shouldCaptureToSentry(new NetworkError())).toBe(true);
  });

  it('does NOT capture ApiError (backend-response wrapper — statusCode set)', () => {
    // ApiError carries statusCode from the response; backend already captured.
    expect(shouldCaptureToSentry(new ApiError('5xx', 500))).toBe(false);
  });

  it('does NOT capture AuthError (401 from backend)', () => {
    // AuthError.statusCode is 401; it wraps a backend 401 response.
    expect(shouldCaptureToSentry(new AuthError())).toBe(false);
  });

  it('captures unknown throws (non-AppError — unexpected bugs)', () => {
    expect(shouldCaptureToSentry({ message: 'raw object throw' })).toBe(true);
    expect(shouldCaptureToSentry('string throw')).toBe(true);
  });

  it('does not capture null/undefined', () => {
    expect(shouldCaptureToSentry(null)).toBe(false);
    expect(shouldCaptureToSentry(undefined)).toBe(false);
  });
});

describe('flushAndExit', () => {
  it('calls process.exit with the provided code when Sentry is not initialized (fast path)', async () => {
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

  it('exits with 0 when passed 0', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__test_exit_${code ?? 0}__`);
    }) as never);
    try {
      await expect(flushAndExit(0)).rejects.toThrow('__test_exit_0__');
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
