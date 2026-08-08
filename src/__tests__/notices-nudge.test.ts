import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { readCredentials } from '../auth/store.js';
import { getEffectiveApiUrl } from '../config/env-profiles.js';
import {
  cacheFilePath,
  credentialFingerprint,
  maybeNudge,
  readCache,
  recordNoticeAcked,
  recordNoticesSnapshot,
  shouldShowNudge,
  writeCacheAtomic,
  type NoticesCache,
  type NudgeGateEnv,
} from '../notices-nudge.js';

const mockedSpawn = vi.mocked(spawn);
const mockedCreds = vi.mocked(readCredentials);

/** AIT-358 — unread-notices nudge: cached print + detached refresh. */

const AGENT_CREDS = {
  accessToken: 'hmok_secret',
  refreshToken: '',
  expiresAt: 0,
  kind: 'agent' as const,
  credentialPublicId: 'agc_12345678',
};

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const unreadCache: NoticesCache = {
  hasUnread: true,
  count: 2,
  lastAttemptedAt: new Date(NOW - HOUR).toISOString(),
  lastCheckedAt: new Date(NOW - HOUR).toISOString(),
};

const baseEnv: NudgeGateEnv = {
  isTTY: true,
  argv: ['node', 'hookmyapp', 'channels', 'list'],
  ci: false,
  optOut: false,
  cache: unreadCache,
  now: NOW,
};

let dir: string;
const SAVED_ENV = ['HOOKMYAPP_CONFIG_DIR', 'HOOKMYAPP_ENV', 'HOOKMYAPP_NO_NOTICES', 'CI'] as const;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hma-nudge-'));
  for (const k of SAVED_ENV) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOOKMYAPP_CONFIG_DIR = dir;
  vi.clearAllMocks();
  mockedSpawn.mockReturnValue({ unref: vi.fn() } as never);
});

afterEach(() => {
  for (const k of SAVED_ENV) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('shouldShowNudge (pure gate)', () => {
  it('(a) no banner when cache says no unread', () => {
    expect(shouldShowNudge({ ...baseEnv, cache: { ...unreadCache, hasUnread: false } })).toBe(false);
    expect(shouldShowNudge({ ...baseEnv, cache: null })).toBe(false);
  });

  it('(b) banner when hasUnread and lastNudgedAt is stale or absent', () => {
    expect(shouldShowNudge(baseEnv)).toBe(true);
    expect(
      shouldShowNudge({
        ...baseEnv,
        cache: { ...unreadCache, lastNudgedAt: new Date(NOW - 25 * HOUR).toISOString() },
      }),
    ).toBe(true);
  });

  it('(c) suppressed within 24h of the last nudge', () => {
    expect(
      shouldShowNudge({
        ...baseEnv,
        cache: { ...unreadCache, lastNudgedAt: new Date(NOW - HOUR).toISOString() },
      }),
    ).toBe(false);
  });

  it('(c) suppressed on opt-out / non-TTY / --json / CI', () => {
    expect(shouldShowNudge({ ...baseEnv, optOut: true })).toBe(false);
    expect(shouldShowNudge({ ...baseEnv, isTTY: false })).toBe(false);
    expect(shouldShowNudge({ ...baseEnv, argv: [...baseEnv.argv, '--json'] })).toBe(false);
    expect(shouldShowNudge({ ...baseEnv, ci: true })).toBe(false);
  });

  it('(c) suppressed when the invoked command is notifications itself', () => {
    expect(
      shouldShowNudge({ ...baseEnv, argv: ['node', 'hookmyapp', 'notifications', 'list'] }),
    ).toBe(false);
  });
});

describe('maybeNudge refresh spawn', () => {
  it('(d) spawns detached when lastAttemptedAt is stale, stamping BEFORE spawn', async () => {
    mockedCreds.mockResolvedValue(AGENT_CREDS);
    let stampedAtSpawnTime: NoticesCache | null = null;
    let spawnOpts: Record<string, unknown> | null = null;
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: { env: Record<string, string> }) => {
      spawnOpts = opts as Record<string, unknown>;
      stampedAtSpawnTime = JSON.parse(readFileSync(opts.env.HOOKMYAPP_NOTICES_CACHE, 'utf-8')) as NoticesCache;
      return { unref: vi.fn() };
    }) as never);

    await maybeNudge();

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    expect(stampedAtSpawnTime!.lastAttemptedAt).toBeDefined();
    expect(spawnOpts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('(d) does NOT spawn when lastAttemptedAt is fresh (<24h)', async () => {
    mockedCreds.mockResolvedValue(AGENT_CREDS);
    const file = cacheFilePath(getEffectiveApiUrl(), credentialFingerprint(AGENT_CREDS));
    writeCacheAtomic(file, { ...unreadCache, hasUnread: false });
    await maybeNudge();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('(e) never spawns (or writes cache) without stored credentials', async () => {
    mockedCreds.mockResolvedValue(null);
    await maybeNudge();
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('HOOKMYAPP_NO_NOTICES suppresses the whole machinery', async () => {
    process.env.HOOKMYAPP_NO_NOTICES = '1';
    mockedCreds.mockResolvedValue(AGENT_CREDS);
    await maybeNudge();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});

describe('maybeNudge banner', () => {
  it('prints one stderr line and stamps lastNudgedAt when unread + TTY', async () => {
    mockedCreds.mockResolvedValue(AGENT_CREDS);
    const file = cacheFilePath(getEffectiveApiUrl(), credentialFingerprint(AGENT_CREDS));
    writeCacheAtomic(file, { ...unreadCache, lastAttemptedAt: new Date().toISOString() });
    const ttyBackup = process.stderr.isTTY;
    process.stderr.isTTY = true;
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let out = '';
    try {
      await maybeNudge();
      out = write.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      write.mockRestore();
      process.stderr.isTTY = ttyBackup;
    }
    expect(out).toContain('Unread notices from HookMyApp');
    expect(out).toContain('hookmyapp notifications');
    expect(readCache(file)?.lastNudgedAt).toBeDefined();
  });
});

describe('cache namespacing', () => {
  it('(f) cache path differs per API origin and per credential fingerprint', () => {
    expect(cacheFilePath('https://api.hookmyapp.com', 'agc_1')).not.toBe(
      cacheFilePath('https://staging-api.hookmyapp.com', 'agc_1'),
    );
    expect(cacheFilePath('https://api.hookmyapp.com', 'agc_1')).not.toBe(
      cacheFilePath('https://api.hookmyapp.com', 'agc_2'),
    );
  });

  it('credentialFingerprint never returns raw secrets', () => {
    expect(credentialFingerprint(AGENT_CREDS)).toBe('agc_12345678');
    const jwt = ['x', Buffer.from(JSON.stringify({ sub: 'user_01ABC' })).toString('base64'), 'y'].join('.');
    const workos = { accessToken: jwt, refreshToken: 'rt_secret', expiresAt: 1 };
    expect(credentialFingerprint(workos)).toBe('user_01ABC');
    expect(credentialFingerprint(workos)).not.toContain('secret');
  });
});

describe('immediate consistency from notifications command', () => {
  it('recordNoticesSnapshot rewrites the cache from the real response', async () => {
    mockedCreds.mockResolvedValue(AGENT_CREDS);
    await recordNoticesSnapshot(3);
    const file = cacheFilePath(getEffectiveApiUrl(), credentialFingerprint(AGENT_CREDS));
    expect(readCache(file)).toMatchObject({ hasUnread: true, count: 3 });
  });

  it('recordNoticeAcked decrements; acking the last notice kills the nudge', async () => {
    mockedCreds.mockResolvedValue(AGENT_CREDS);
    await recordNoticesSnapshot(1);
    await recordNoticeAcked();
    const file = cacheFilePath(getEffectiveApiUrl(), credentialFingerprint(AGENT_CREDS));
    expect(readCache(file)).toMatchObject({ hasUnread: false, count: 0 });
  });
});
