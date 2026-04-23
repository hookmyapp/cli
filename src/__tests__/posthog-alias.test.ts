// Phase 125 Plan 02 Task 1 — PostHog alias-on-login contract tests.
//
// CONTEXT.md §3 + RESEARCH §Pattern 3 + §Pitfall 1:
//   The CLI captures pre-login events under a machine-id (`distinctId`).
//   On the FIRST successful login per (machine, user) pair, we call
//   `posthog.alias({ distinctId: workosSub, alias: machineId })` so PostHog
//   stitches the anonymous machine-scoped events onto the user profile that
//   the app + marketing already write.
//
// Direction matters (RESEARCH §Pitfall 1): `distinctId` is the canonical user
// id (workosSub); `alias` is the side identifier we want to merge in
// (machineId). Reversing the args — `{ distinctId: machineId, alias: sub }` —
// would silently merge the user profile into the machine, breaking app↔CLI
// stitching for every event from then on.
//
// Per-pair persistence (CONTEXT.md §3): `posthogAliasedUsers: [...]` in
// config.json prevents repeated alias calls on every login; a different
// workosSub on the same machine still fires alias once for that pair.
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
  posthogAliasAndIdentify,
  __resetForTests as resetPostHog,
} from '../observability/posthog.js';
import { unsetPersistedTelemetry } from '../observability/telemetry.js';

function configPath(): string {
  const dir = process.env.HOOKMYAPP_CONFIG_DIR;
  if (!dir) throw new Error('HOOKMYAPP_CONFIG_DIR not set');
  return join(dir, 'config.json');
}

function readConfigRaw(): Record<string, unknown> {
  if (!existsSync(configPath())) return {};
  return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
}

function resetConfig(): void {
  const dir = process.env.HOOKMYAPP_CONFIG_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), '{}');
}

describe('posthogAliasAndIdentify', () => {
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

  it('first call fires alias({ distinctId: workosSub, alias: machineId }) exactly once', async () => {
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'device',
    });
    expect(fakeAlias).toHaveBeenCalledTimes(1);
    const args = fakeAlias.mock.calls[0][0];
    expect(args.distinctId).toBe('user_workos_abc123');
    // alias direction: machineId is the side identifier; pull it from config
    const cfg = readConfigRaw();
    expect(args.alias).toBe(cfg.posthogDistinctId);
    expect(typeof cfg.posthogDistinctId).toBe('string');
    expect((cfg.posthogDistinctId as string).length).toBeGreaterThan(0);
  });

  it('persists workosSub to posthogAliasedUsers + lastWorkosSub after first alias', async () => {
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'device',
    });
    const cfg = readConfigRaw();
    expect(cfg.posthogAliasedUsers).toEqual(['user_workos_abc123']);
    expect(cfg.lastWorkosSub).toBe('user_workos_abc123');
  });

  it('second call with same workosSub does NOT re-fire alias (per-pair persistence)', async () => {
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'device',
    });
    expect(fakeAlias).toHaveBeenCalledTimes(1);
    fakeAlias.mockClear();
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'device',
    });
    expect(fakeAlias).not.toHaveBeenCalled();
  });

  it('different workosSub on same machine fires alias again (new pair)', async () => {
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'device',
    });
    expect(fakeAlias).toHaveBeenCalledTimes(1);
    fakeAlias.mockClear();
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_xyz789',
      loginMethod: 'code',
    });
    expect(fakeAlias).toHaveBeenCalledTimes(1);
    expect(fakeAlias.mock.calls[0][0].distinctId).toBe('user_workos_xyz789');
    const cfg = readConfigRaw();
    expect(cfg.posthogAliasedUsers).toEqual(['user_workos_abc123', 'user_workos_xyz789']);
  });

  it('also emits cli_logged_in with login_method', async () => {
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'code',
    });
    const calls = fakeCapture.mock.calls;
    const loggedIn = calls.find((c) => c[0]?.event === 'cli_logged_in');
    expect(loggedIn).toBeTruthy();
    expect(loggedIn![0].properties.login_method).toBe('code');
  });

  it('falls back to JWT sub when workosSub is not provided', async () => {
    // Build a minimal HS256-style JWT with sub claim — we never verify, just decode.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user_jwt_zzz' })).toString('base64url');
    const fakeJwt = `${header}.${payload}.signature`;
    await posthogAliasAndIdentify({
      jwt: fakeJwt,
      loginMethod: 'device',
    });
    expect(fakeAlias).toHaveBeenCalledTimes(1);
    expect(fakeAlias.mock.calls[0][0].distinctId).toBe('user_jwt_zzz');
  });

  it('is a no-op when telemetry is disabled (no alias, no capture)', async () => {
    process.env.HOOKMYAPP_TELEMETRY = 'off';
    resetPostHog();
    await posthogAliasAndIdentify({
      jwt: null,
      workosSub: 'user_workos_abc123',
      loginMethod: 'device',
    });
    expect(fakeAlias).not.toHaveBeenCalled();
    expect(fakeCapture).not.toHaveBeenCalled();
    // Persisted state is also untouched on the no-op path:
    const cfg = readConfigRaw();
    expect(cfg.posthogAliasedUsers).toBeUndefined();
  });
});
