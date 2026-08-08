// Unread-notices nudge (AIT-358) — modeled on src/update-check.ts (AIT-24),
// which already solved this exact problem: the CLI hard-exits after
// parseAsync (flushAndExit / process.exit in sentry.ts), so an unawaited
// in-process fetch is killed mid-flight. Therefore:
//
//   - PRINT path is synchronous and instant: read the PREVIOUS run's cache
//     from disk at boot and, when it says unread + last nudge >24h ago, write
//     one stderr line. Same guardrails as the update banner: stderr only,
//     TTY only, no CI, no --json, env opt-out (HOOKMYAPP_NO_NOTICES).
//   - REFRESH path runs in a DETACHED spawned child (survives the parent's
//     hard exit) that calls GET /notices and atomically rewrites the cache
//     for the NEXT run. Throttled to ≤1 attempt per 24h; `lastAttemptedAt`
//     is stamped BEFORE the spawn so a failing refresh cannot retry on
//     every command. The child swallows all errors (fail-open).
//
// The cache file is namespaced by API origin + a NON-SECRET credential
// fingerprint: getConfigDir() is global, so env switches (--env staging) and
// re-logins must not leak another principal's unread count.
// `notifications list`/`ack` rewrite the cache from their real responses
// (recordNoticesSnapshot / recordNoticeAcked) for immediate consistency.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { readCredentials } from './auth/store.js';
import type { Secrets } from './storage/secrets.js';
import { getEffectiveApiUrl } from './config/env-profiles.js';
import { getConfigDir } from './storage/path.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface NoticesCache {
  hasUnread: boolean;
  count: number;
  /** Last background-refresh attempt (stamped before spawn — throttle key). */
  lastAttemptedAt?: string;
  /** Last SUCCESSFUL read of /notices (child or notifications command). */
  lastCheckedAt?: string;
  lastNudgedAt?: string;
}

/** Non-secret identity for cache namespacing. Never a raw token. */
export function credentialFingerprint(creds: Secrets): string {
  if (creds.credentialPublicId) return creds.credentialPublicId;
  try {
    // WorkOS sessions: the JWT `sub` claim is a stable, non-secret user id
    // (the access token itself rotates on refresh — useless as a cache key).
    const payload = JSON.parse(
      Buffer.from(creds.accessToken.split('.')[1] ?? '', 'base64').toString(),
    ) as { sub?: unknown };
    if (typeof payload.sub === 'string' && payload.sub) return payload.sub;
  } catch {
    // Not a JWT — fall through.
  }
  return creds.email ?? 'unknown';
}

export function cacheFilePath(apiUrl: string, fingerprint: string): string {
  const key = createHash('sha256').update(`${apiUrl}\0${fingerprint}`).digest('hex').slice(0, 16);
  return join(getConfigDir(), `notices-nudge-${key}.json`);
}

export function readCache(file: string): NoticesCache | null {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as NoticesCache;
  } catch {
    return null; // missing or corrupt — treated as "never checked"
  }
}

/** tmp + rename — concurrent CLI invocations race on this file otherwise. */
export function writeCacheAtomic(file: string, cache: NoticesCache): void {
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}

export interface NudgeGateEnv {
  isTTY: boolean;
  argv: string[];
  ci: boolean;
  optOut: boolean;
  cache: NoticesCache | null;
  now: number;
}

/** Pure gate — all print-suppression rules in one testable place. */
export function shouldShowNudge(env: NudgeGateEnv): boolean {
  if (env.optOut || env.ci || !env.isTTY) return false;
  if (env.argv.includes('--json')) return false;
  if (isNotificationsInvocation(env.argv)) return false;
  if (!env.cache?.hasUnread) return false;
  if (env.cache.lastNudgedAt && env.now - Date.parse(env.cache.lastNudgedAt) < DAY_MS) {
    return false; // throttle: at most one nudge per day
  }
  return true;
}

// ponytail: substring scan, not a real argv parse — a literal "notifications"
// argument to some other command merely skips one nudge, which is harmless.
function isNotificationsInvocation(argv: string[]): boolean {
  return argv.slice(2).includes('notifications');
}

// Runs under `node -e` (CJS): fetch /notices with the stored bearer token and
// atomically rewrite the cache, preserving unrelated fields (lastNudgedAt).
// Every failure path is a silent no-op — the next 24h window retries.
const REFRESH_SCRIPT = `
(async () => {
  const res = await fetch(process.env.HOOKMYAPP_NOTICES_URL, {
    headers: { Authorization: 'Bearer ' + process.env.HOOKMYAPP_NOTICES_TOKEN },
  });
  if (!res.ok) return;
  const data = await res.json();
  const notices = Array.isArray(data && data.notices) ? data.notices : [];
  const fs = require('node:fs');
  const file = process.env.HOOKMYAPP_NOTICES_CACHE;
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  const next = Object.assign({}, prev, {
    hasUnread: notices.length > 0,
    count: notices.length,
    lastCheckedAt: new Date().toISOString(),
  });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file);
})().catch(() => {});
`;

/**
 * Boot hook — call once from main() right after maybeNotifyUpdate (same
 * boundary: before the command runs, so every invocation — including ones
 * that fail — is covered, and long-running streams are never interrupted
 * mid-flow). Never throws.
 */
export async function maybeNudge(): Promise<void> {
  try {
    if (process.env.HOOKMYAPP_NO_NOTICES) return;
    if (process.env.CI) return;
    // The notifications command rewrites the cache from its own response —
    // nudging or refreshing here would be redundant noise.
    if (isNotificationsInvocation(process.argv)) return;
    const creds = await readCredentials();
    if (creds === null) return; // no credentials → no fetch, no cache, no nudge
    const apiUrl = getEffectiveApiUrl();
    const file = cacheFilePath(apiUrl, credentialFingerprint(creds));
    const cache = readCache(file);
    const now = Date.now();

    if (
      shouldShowNudge({
        isTTY: Boolean(process.stderr.isTTY),
        argv: process.argv,
        ci: false, // handled above
        optOut: false, // handled above
        cache,
        now,
      })
    ) {
      process.stderr.write('\nUnread notices from HookMyApp — run: hookmyapp notifications\n\n');
      writeCacheAtomic(file, { ...(cache as NoticesCache), lastNudgedAt: new Date(now).toISOString() });
    }

    const attempted = cache?.lastAttemptedAt ? Date.parse(cache.lastAttemptedAt) : 0;
    if (now - attempted < DAY_MS) return;
    // Stamp BEFORE spawning: a refresh that keeps failing (expired token,
    // backend down) must not retry on every single command.
    const current = readCache(file) ?? { hasUnread: false, count: 0 };
    writeCacheAtomic(file, { ...current, lastAttemptedAt: new Date(now).toISOString() });
    const child = spawn(process.execPath, ['-e', REFRESH_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        HOOKMYAPP_NOTICES_URL: `${apiUrl}/notices`,
        HOOKMYAPP_NOTICES_TOKEN: creds.accessToken,
        HOOKMYAPP_NOTICES_CACHE: file,
      },
    });
    child.unref();
  } catch {
    // The nudge must NEVER break or slow a real command — same fail-open
    // policy as update-check.ts.
  }
}

/** `notifications list` calls this with the unread count from its real response. */
export async function recordNoticesSnapshot(unreadCount: number): Promise<void> {
  const now = new Date().toISOString();
  await rewriteCache((prev) => ({
    ...prev,
    hasUnread: unreadCount > 0,
    count: unreadCount,
    lastCheckedAt: now,
    lastAttemptedAt: now, // a real list IS a check — postpone the background refresh
  }));
}

/** `notifications ack` calls this after a successful ack. */
export async function recordNoticeAcked(): Promise<void> {
  await rewriteCache((prev) => {
    const count = Math.max(0, (prev.count ?? 0) - 1);
    return { ...prev, hasUnread: count > 0, count, lastCheckedAt: new Date().toISOString() };
  });
}

async function rewriteCache(update: (prev: NoticesCache) => NoticesCache): Promise<void> {
  try {
    const creds = await readCredentials();
    if (creds === null) return;
    const file = cacheFilePath(getEffectiveApiUrl(), credentialFingerprint(creds));
    writeCacheAtomic(file, update(readCache(file) ?? { hasUnread: false, count: 0 }));
  } catch {
    // Cache maintenance must never fail the command that triggered it.
  }
}
