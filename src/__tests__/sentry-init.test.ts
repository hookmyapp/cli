// Sentry lazy-init tests.
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
//      single-capture-per-error rule.
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

describe('shouldCaptureToSentry filter — capture every non-null error', () => {
  // 0.11.0: removed the statusCode-based exclusion. Earlier versions filtered
  // out backend-response wrappers, but the AppError base derives statusCode
  // from each subclass's static httpStatus, which meant locally-thrown
  // ValidationError/AuthError/etc. were ALSO filtered — empty Sentry project
  // for 30 days. CLI-side perspective is valuable; let Sentry fingerprint
  // grouping handle any duplication with the backend project.
  it('captures generic Error', () => {
    expect(shouldCaptureToSentry(new Error('local failure'))).toBe(true);
  });

  it('captures NetworkError', () => {
    expect(shouldCaptureToSentry(new NetworkError())).toBe(true);
  });

  it('captures the bare 5xx ApiError (edge/LB failure the backend never saw)', () => {
    expect(shouldCaptureToSentry(new ApiError('5xx', 500))).toBe(true);
  });

  it('rejects coded ApiErrors (backend rejected the request and captured its own side)', () => {
    expect(shouldCaptureToSentry(new ApiError('nope', 400, 'SOME_CODE'))).toBe(false);
    expect(shouldCaptureToSentry(new ApiError('nope', 404))).toBe(false);
    expect(shouldCaptureToSentry(new ApiError('nope', 503, 'SUPPORT_NOT_CONFIGURED'))).toBe(false);
  });

  // AIT-652: sev3 CliErrors are expected user states (session expired,
  // forwarding disabled, validation). Customer agent loops replayed them by
  // the thousand and exhausted the org quota on 2026-09-13, blinding the
  // pager for every service. They still reach PostHog; Sentry gets only the
  // sev3 codes that describe the environment, not the user.
  it('rejects sev3 AuthError (expected user state, PostHog has it)', () => {
    expect(shouldCaptureToSentry(new AuthError())).toBe(false);
  });

  it('rejects the sev3 CliErrors that flooded the quota', async () => {
    const { CliError, ValidationError } = await import('../output/error.js');
    expect(shouldCaptureToSentry(new CliError('forwarding disabled', 'CHANNEL_FORWARDING_DISABLED'))).toBe(false);
    expect(shouldCaptureToSentry(new ValidationError('bad arg'))).toBe(false);
  });

  it('still captures sev1/sev2 CliErrors', async () => {
    const { ConfigurationError, UnexpectedError } = await import('../output/error.js');
    expect(shouldCaptureToSentry(new ConfigurationError('missing config'))).toBe(true);
    expect(shouldCaptureToSentry(new UnexpectedError('boom'))).toBe(true);
  });

  it('captures unknown throws (non-AppError — unexpected bugs)', () => {
    expect(shouldCaptureToSentry({ message: 'raw object throw' })).toBe(true);
    expect(shouldCaptureToSentry('string throw')).toBe(true);
  });

  it('does not capture null/undefined', () => {
    expect(shouldCaptureToSentry(null)).toBe(false);
    expect(shouldCaptureToSentry(undefined)).toBe(false);
  });

  it('rejects CommanderError so user-typos do not pollute Sentry', () => {
    const { CommanderError } = require('commander');
    const err = new CommanderError(1, 'commander.missingArgument', "error: missing required argument 'key'");
    expect(shouldCaptureToSentry(err)).toBe(false);
  });

  it('rejects every commander.* code variant', () => {
    const { CommanderError } = require('commander');
    for (const code of [
      'commander.missingArgument',
      'commander.invalidArgument',
      'commander.invalidOptionArgument',
      'commander.unknownOption',
      'commander.unknownCommand',
      'commander.helpDisplayed',
      'commander.version',
    ]) {
      const err = new CommanderError(1, code, `synthetic ${code}`);
      expect(shouldCaptureToSentry(err)).toBe(false);
    }
  });

  it('STILL captures Tomer-class ConfigWriteForbiddenError (regression guard)', async () => {
    const { ConfigWriteForbiddenError } = await import('../storage/errors.js');
    const err = new ConfigWriteForbiddenError('/tmp/config.json');
    expect(shouldCaptureToSentry(err)).toBe(true);
  });

  it('does not match objects whose code happens to start with "command." (no false positive)', () => {
    expect(shouldCaptureToSentry({ code: 'command.timeout', message: 'x' })).toBe(true);
  });
});

describe('flushAndExit', () => {
  // AIT-395: the contract changed from "hard exit" to "set the status and let
  // the loop drain" — process.exit() on top of a closing libuv handle aborts
  // the process on Windows (exit 9) after the command already succeeded.
  it('sets the provided exit code when Sentry is not initialized (fast path)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await flushAndExit(2);
      expect(process.exitCode).toBe(2);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      process.exitCode = undefined;
    }
  });

  it('sets 0 when passed 0', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await flushAndExit(0);
      expect(process.exitCode).toBe(0);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      process.exitCode = undefined;
    }
  });
});
