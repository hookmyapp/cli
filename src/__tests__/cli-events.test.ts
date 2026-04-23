// Phase 125 Plan 02 Task 1 — CLI command-invocation event tests.
//
// CONTEXT.md §5: every real command emits `cli_command_invoked` on exit
// with `{ command, subcommand, exit_code, duration_ms, cli_version,
// node_version, platform }`; meta commands (`help`, `--help`, `--version`)
// are excluded; first-ever invocation emits `cli_first_run` once. Errors
// also emit `cli_error_shown`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  emit,
  __resetForTests as resetPostHog,
  shouldEmitCommandInvoked,
  maybeEmitFirstRun,
} from '../observability/posthog.js';
import { runWithInstrumentation } from '../commands/_helpers.js';
import { ValidationError, AuthError } from '../output/error.js';
import { unsetPersistedTelemetry } from '../observability/telemetry.js';

function configPath(): string {
  return join(process.env.HOOKMYAPP_CONFIG_DIR!, 'config.json');
}

function readConfigRaw(): Record<string, unknown> {
  if (!existsSync(configPath())) return {};
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
}

function resetConfig(): void {
  mkdirSync(process.env.HOOKMYAPP_CONFIG_DIR!, { recursive: true });
  writeFileSync(configPath(), '{}');
}

describe('cli_command_invoked emission', () => {
  beforeEach(() => {
    resetConfig();
    resetPostHog();
    fakePostHogCtor.mockReset();
    fakeCapture.mockReset();
    fakeAlias.mockReset();
    fakeOn.mockReset();
    delete process.env.HOOKMYAPP_TELEMETRY;
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_test';
    unsetPersistedTelemetry();
  });

  afterEach(() => {
    delete process.env.HOOKMYAPP_POSTHOG_TOKEN;
    resetPostHog();
  });

  it('emits cli_command_invoked on success with exit_code:0 + duration_ms + baseline props', async () => {
    const exitCode = await runWithInstrumentation('workspace', 'list', async () => {
      return 0;
    });
    expect(exitCode).toBe(0);
    const inv = fakeCapture.mock.calls.find((c) => c[0]?.event === 'cli_command_invoked');
    expect(inv).toBeTruthy();
    const props = inv![0].properties;
    expect(props.command).toBe('workspace');
    expect(props.subcommand).toBe('list');
    expect(props.exit_code).toBe(0);
    expect(typeof props.duration_ms).toBe('number');
    expect(props.duration_ms).toBeGreaterThanOrEqual(0);
    expect(props.node_version).toBe(process.version);
    expect(props.platform).toBe(process.platform);
    expect(props.site).toBe('cli');
    expect(typeof props.cli_version).toBe('string');
  });

  it('emits cli_command_invoked AND cli_error_shown when the command throws a CliError', async () => {
    await expect(
      runWithInstrumentation('workspace', 'use', async () => {
        throw new ValidationError('bad workspace name', 'BAD_WS');
      }),
    ).rejects.toThrow();
    const inv = fakeCapture.mock.calls.find((c) => c[0]?.event === 'cli_command_invoked');
    expect(inv).toBeTruthy();
    expect(inv![0].properties.exit_code).toBe(2); // ValidationError → 2
    const err = fakeCapture.mock.calls.find((c) => c[0]?.event === 'cli_error_shown');
    expect(err).toBeTruthy();
    expect(err![0].properties.error_code).toBe('BAD_WS');
    expect(err![0].properties.exit_code).toBe(2);
    expect(err![0].properties.command).toBe('workspace');
  });

  it('maps AuthError → exit_code:4 on cli_command_invoked', async () => {
    await expect(
      runWithInstrumentation('login', null, async () => {
        throw new AuthError();
      }),
    ).rejects.toThrow();
    const inv = fakeCapture.mock.calls.find((c) => c[0]?.event === 'cli_command_invoked');
    expect(inv![0].properties.exit_code).toBe(4);
  });

  it('shouldEmitCommandInvoked returns false for help/--help/-h/--version/-v', () => {
    for (const meta of ['help', '--help', '-h', '--version', '-v']) {
      expect(shouldEmitCommandInvoked(meta, null)).toBe(false);
      expect(shouldEmitCommandInvoked('whatever', meta)).toBe(false);
    }
    expect(shouldEmitCommandInvoked('workspace', 'list')).toBe(true);
    expect(shouldEmitCommandInvoked('login', null)).toBe(true);
  });
});

describe('cli_first_run emission', () => {
  beforeEach(() => {
    resetConfig();
    resetPostHog();
    fakeCapture.mockReset();
    delete process.env.HOOKMYAPP_TELEMETRY;
    process.env.HOOKMYAPP_POSTHOG_TOKEN = 'phc_test';
    unsetPersistedTelemetry();
  });

  it('on first-ever invocation emits cli_first_run + persists posthogDistinctId', async () => {
    await maybeEmitFirstRun();
    const cfg = readConfigRaw();
    expect(typeof cfg.posthogDistinctId).toBe('string');
    expect((cfg.posthogDistinctId as string).length).toBeGreaterThan(0);
    const fr = fakeCapture.mock.calls.find((c) => c[0]?.event === 'cli_first_run');
    expect(fr).toBeTruthy();
    expect(fr![0].properties.node_version).toBe(process.version);
    expect(fr![0].properties.platform).toBe(process.platform);
  });

  it('subsequent invocations do NOT re-emit cli_first_run', async () => {
    await maybeEmitFirstRun();
    fakeCapture.mockClear();
    await maybeEmitFirstRun();
    const fr = fakeCapture.mock.calls.find((c) => c[0]?.event === 'cli_first_run');
    expect(fr).toBeFalsy();
  });
});
