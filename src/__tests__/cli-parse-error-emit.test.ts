// Phase 0.11.1 — cli_parse_error emission unit test.
//
// CommanderError parse failures must reach PostHog as cli_parse_error,
// not Sentry. Validates the helper that index.ts catch block calls.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fakeCapture = vi.fn();
class FakePostHog {
  capture = fakeCapture;
  on = vi.fn();
  shutdown = vi.fn().mockResolvedValue(undefined);
  alias = vi.fn();
  identify = vi.fn();
}
vi.mock('posthog-node', () => ({ PostHog: FakePostHog }));

import { emitParseError, __resetForTests as resetPostHog } from '../observability/posthog.js';
import { unsetPersistedTelemetry } from '../observability/telemetry.js';

describe('emitParseError', () => {
  const origToken = process.env.HOOKMYAPP_POSTHOG_TOKEN;

  beforeEach(() => {
    resetPostHog();
    fakeCapture.mockClear();
    unsetPersistedTelemetry();
    delete process.env.HOOKMYAPP_TELEMETRY;
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_test_token';
  });

  afterEach(() => {
    if (origToken === undefined) delete process.env.HOOKMYAPP_POSTHOG_TOKEN;
    else process.env.HOOKMYAPP_POSTHOG_TOKEN = origToken;
  });

  it('captures cli_parse_error with argv tokens and error code', async () => {
    await emitParseError({
      errorCode: 'commander.missingArgument',
      argv: ['/usr/bin/node', '/usr/bin/hookmyapp', 'config', 'get'],
    });
    expect(fakeCapture).toHaveBeenCalledOnce();
    const args = fakeCapture.mock.calls[0][0];
    expect(args.event).toBe('cli_parse_error');
    expect(args.properties.error_code).toBe('commander.missingArgument');
    expect(args.properties.argv_first_token).toBe('config');
    expect(args.properties.argv_second_token).toBe('get');
    expect(args.properties.platform).toBe(process.platform);
    expect(args.properties.node_version).toBe(process.version);
  });

  it('emits null tokens when argv has no non-flag positional after the binary', async () => {
    await emitParseError({
      errorCode: 'commander.unknownOption',
      argv: ['/usr/bin/node', '/usr/bin/hookmyapp', '--bogus'],
    });
    const args = fakeCapture.mock.calls[0][0];
    expect(args.properties.argv_first_token).toBeNull();
    expect(args.properties.argv_second_token).toBeNull();
  });

  it('skips emit when telemetry is off', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    resetPostHog();
    await emitParseError({
      errorCode: 'commander.missingArgument',
      argv: ['/usr/bin/node', '/usr/bin/hookmyapp', 'config', 'get'],
    });
    expect(fakeCapture).not.toHaveBeenCalled();
  });

  it('skips --workspace value to avoid leaking workspace slug as a positional', async () => {
    await emitParseError({
      errorCode: 'commander.missingArgument',
      argv: ['/usr/bin/node', '/usr/bin/hookmyapp', '--workspace', 'customer-acme', 'config', 'get'],
    });
    const args = fakeCapture.mock.calls[0][0];
    expect(args.properties.argv_first_token).toBe('config');
    expect(args.properties.argv_second_token).toBe('get');
  });

  it('skips --env value to avoid leaking the environment profile name as a positional', async () => {
    await emitParseError({
      errorCode: 'commander.missingArgument',
      argv: ['/usr/bin/node', '/usr/bin/hookmyapp', '--env', 'staging', 'config', 'get'],
    });
    const args = fakeCapture.mock.calls[0][0];
    expect(args.properties.argv_first_token).toBe('config');
    expect(args.properties.argv_second_token).toBe('get');
  });

  it('handles --workspace and --env interleaved with boolean flags', async () => {
    await emitParseError({
      errorCode: 'commander.missingArgument',
      argv: ['/usr/bin/node', '/usr/bin/hookmyapp', '--debug', '--workspace', 'foo', '--env', 'staging', 'config', 'get'],
    });
    const args = fakeCapture.mock.calls[0][0];
    expect(args.properties.argv_first_token).toBe('config');
    expect(args.properties.argv_second_token).toBe('get');
  });
});
