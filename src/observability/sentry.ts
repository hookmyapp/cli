// Phase 123 Plan 10 — lazy Sentry init + flush-on-exit + setUser.
//
// Design rules (from 123-RESEARCH.md Pattern 7):
//
// 1. LAZY INIT. Sentry is a ~50–80 KB module. The CLI is a short-lived
//    command-line tool invoked frequently (every sandbox listen tick, every
//    workspace list). Eagerly loading Sentry on every invocation burns ~30 ms
//    of startup time for no gain on the happy path. Instead:
//      - `initSentryLazy()` dynamic-imports `@sentry/node` only if
//        `isTelemetryEnabled()` returns true AND a DSN is baked at build time.
//      - Authenticated command entry points call `initSentryLazy()` +
//        `setCliUserFromCreds()` so the user tag is set before any capture.
//
// 2. FLUSH ON EXIT. Sentry buffers events. If we `process.exit()`
//    immediately, in-flight events are lost. `flushAndExit(code)` awaits a
//    2-second `Sentry.close()` then exits — the drain is best-effort (happy
//    path: 50 ms; worst case: 2 s).
//
// 3. CAPTURE ONLY LOCAL CLI FAILURES. Per CONTEXT.md §single-capture-per-error:
//    the CLI captures command crashes, pre-backend network failures (fetch
//    TypeError / DNS), and unhandled rejections. It does NOT re-capture HTTP
//    5xx from the backend — the backend already has those events with full
//    context. Callers filter via `shouldCaptureToSentry(err)`.
//
// 4. TREE-SHAKING. `build.mjs` sets `__SENTRY_TRACING__=false` +
//    `__SENTRY_DEBUG__=false` via esbuild `define`, stripping the tracing/
//    profiling/debug code paths at bundle time. Still leaves ~50–80 KB (gzip)
//    but cuts 300+ KB of dead code.
//
// 5. DEFAULT-ON + DISCLOSURE. After Sentry.init succeeds, print the one-time
//    first-run disclosure (stderr). `isTelemetryEnabled()` reads the override
//    chain (HOOKMYAPP_TELEMETRY=off env var OR `config set telemetry off`).
//
// 6. INIT IS FILESYSTEM-WRITE-FREE. As of 0.11.0, no syscall in the init
//    path requires a writable filesystem. Audit table:
//
//      isTelemetryEnabled      → read-only, try/catch wraps existsSync+readFileSync
//      resolveDsn/Release/Env  → env-var reads only
//      await import(@sentry)   → module-loader read of node_modules
//      sentryModule.init()     → in-memory; tracesSampleRate:0 disables profiling I/O
//      maybePrintFirstRunDisclosure  → writes config.json BUT IS ISOLATED in its
//                                       own try/catch outside the init success path
//                                       (see initSentryLazy below)
//
//    Do NOT introduce a filesystem write inside the init success path. If a
//    future feature needs post-init filesystem work, isolate it the same way
//    the disclosure call is isolated. The Tomer-class regression that hid every
//    CLI error pre-0.11.0 was caused by violating this rule.

import { isTelemetryEnabled, maybePrintFirstRunDisclosure } from './telemetry.js';
import { decodeJwtSub } from './jwt-light.js';
import { shutdownPostHog } from './posthog.js';
import { getConfigDir } from '../storage/path.js';

// Module-level state — one init per process, one Sentry module instance.
let initialized = false;
let initAttempted = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sentryModule: any = null;

/**
 * DSN is injected at build time via esbuild `define`:
 *   process.env.HOOKMYAPP_SENTRY_DSN  → baked into dist/cli.js
 * Running `tsx src/index.ts` locally (without a bake) reads the env var at
 * runtime; empty DSN → initSentryLazy() no-ops.
 */
function resolveDsn(): string | undefined {
  const dsn = process.env.HOOKMYAPP_SENTRY_DSN;
  return dsn && dsn.length > 0 ? dsn : undefined;
}

/** CLI release identifier (git tag). Baked at build time via esbuild `define`. */
function resolveRelease(): string | undefined {
  const rel = process.env.HOOKMYAPP_CLI_RELEASE;
  return rel && rel.length > 0 ? rel : undefined;
}

/** Environment tag (staging | production | local) — defaults to production. */
function resolveEnvironment(): string {
  return process.env.HOOKMYAPP_ENV ?? 'production';
}

/**
 * Lazy Sentry initialization. Safe to call multiple times — subsequent calls
 * are no-ops. Safe to call when telemetry is disabled — it just returns
 * without loading the Sentry module.
 *
 * Caller pattern:
 *   await initSentryLazy();
 *   // … command work …
 *   await flushAndExit(exitCode);
 */
export async function initSentryLazy(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;

  if (!isTelemetryEnabled()) return;

  const dsn = resolveDsn();
  if (!dsn) return;

  try {
    // Dynamic import — @sentry/node ONLY loads when telemetry is enabled +
    // DSN is present. Build tree-shakes __SENTRY_TRACING__=false + debug.
    sentryModule = await import('@sentry/node');
    const { makeOfflineTransport } = await import('@sentry/core');
    const { makeNodeTransport } = sentryModule;
    const { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Prepare the offline queue directory. A read-only FS (Tomer-class) is
    // handled gracefully: the mkdir is best-effort; if it fails the offline
    // transport falls back to in-memory queuing only (events still ship live
    // when the network is up — just not persisted across process exits).
    const offlineDir = join(getConfigDir(), 'sentry-offline');
    try {
      mkdirSync(offlineDir, { recursive: true });
    } catch {
      // Read-only FS — in-memory queue only; no persistence across exits.
    }

    // File-backed envelope store. Each queued envelope is written as a
    // JSON file named by monotonic timestamp. shift() pops the oldest file.
    // unshift() re-queues a failed retry at the front (lowest timestamp - 1).
    function createFileStore() {
      return {
        async push(env: unknown): Promise<void> {
          try {
            const name = join(offlineDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
            writeFileSync(name, JSON.stringify(env));
          } catch {
            // Write failure is non-fatal — event lost on disk but telemetry
            // must never block the CLI.
          }
        },
        async unshift(env: unknown): Promise<void> {
          // Re-queue at front by using a timestamp slightly before now.
          try {
            const name = join(offlineDir, `${Date.now() - 1}-${Math.random().toString(36).slice(2)}.json`);
            writeFileSync(name, JSON.stringify(env));
          } catch {
            // Non-fatal.
          }
        },
        async shift(): Promise<unknown | undefined> {
          try {
            const files = readdirSync(offlineDir)
              .filter((f) => f.endsWith('.json'))
              .sort();
            if (files.length === 0) return undefined;
            const oldest = files[0];
            const full = join(offlineDir, oldest);
            const raw = readFileSync(full, 'utf-8');
            unlinkSync(full);
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        },
      };
    }

    sentryModule.init({
      dsn,
      release: resolveRelease(),
      environment: resolveEnvironment(),
      enableLogs: true,
      // No tracing in CLI — we're short-lived, don't ship span data.
      tracesSampleRate: 0,
      transport: makeOfflineTransport(makeNodeTransport),
      transportOptions: {
        createStore: createFileStore,
      },
    });
    sentryModule.setTag('service', 'cli');
    initialized = true;
  } catch {
    // Swallow all init errors. Telemetry must NEVER break the CLI.
    sentryModule = null;
    initialized = false;
    return;
  }

  // Disclosure is intentionally OUTSIDE the init try/catch and inside its own
  // try/catch. A filesystem write EPERM from the disclosure helper MUST NOT
  // disable Sentry for the rest of the process (that was the silent-failure
  // mode that hid every CLI error before 0.11.0).
  try {
    maybePrintFirstRunDisclosure();
  } catch {
    // Disclosure-write failures (read-only FS, sandboxed shell) silently
    // skip the banner. The next successful run will print it. No impact
    // on Sentry capture for the rest of this process.
  }
}

/**
 * Pull `sub` from the stored JWT and call `Sentry.setUser({ id: sub })`.
 * Called at the start of authenticated commands so every subsequent event
 * carries the WorkOS user id — enables "show me everything for user X
 * across all services in the last 24h" cross-service queries in Sentry.
 *
 * No-op when telemetry disabled, no credentials, or JWT unparseable.
 */
export async function setCliUserFromCreds(): Promise<void> {
  if (!initAttempted) await initSentryLazy();
  if (!initialized || !sentryModule) return;

  // Lazy-import the store to avoid loading it during CLI commands that don't
  // touch credentials (--help, --version).
  const { readCredentials } = await import('../auth/store.js');
  const creds = await readCredentials();
  if (!creds?.accessToken) return;

  const sub = decodeJwtSub(creds.accessToken);
  if (!sub) return;
  sentryModule.setUser({ id: sub });
}

/**
 * Decide whether to forward an error to Sentry.
 *
 * Capture every non-null error. The CLI-side perspective (user, CLI version,
 * OS, invoked command) is valuable enough to keep even when the backend
 * already captured the same failure on its end. Sentry's automatic
 * fingerprint-based grouping handles any duplication.
 *
 * Earlier versions used a `statusCode` heuristic to exclude backend-response
 * wrappers from re-capture. That was unsafe: the AppError base class derives
 * `statusCode` from each subclass's static `httpStatus` field via an instance
 * getter, so locally-thrown ValidationError/AuthError/ConflictError/etc. ALL
 * carried statusCode and were silently filtered out — which is why the CLI's
 * Sentry project was empty for 30 days despite real users hitting real
 * errors. Removed in 0.11.0.
 *
 * One narrow exception: `commander.*` argv-parse errors (missingArgument,
 * invalidArgument, invalidOptionArgument, unknownOption, unknownCommand,
 * helpDisplayed, version). Commander throws these BEFORE any action handler
 * runs — by definition the user typed argv wrong and Commander rejected it,
 * the environment didn't break anything. These are user-typo / discoverability
 * signals, not engineering errors; they belong in PostHog (`cli_parse_error`
 * event), not Sentry. Duck-typed on `code.startsWith('commander.')` to keep
 * `commander` out of this module's import graph. Tomer-class
 * ConfigWriteForbiddenError (EPERM on a CORRECT command) is unaffected — it
 * carries code `CONFIG_WRITE_FORBIDDEN`, no commander prefix, regression
 * pinned in the test suite.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function shouldCaptureToSentry(err: any): boolean {
  if (err == null) return false;
  if (typeof err?.code === 'string' && err.code.startsWith('commander.')) {
    return false;
  }
  return true;
}

/**
 * Capture a thrown error to Sentry if it's CLI-local (not a backend response).
 * Sets severity/service/code tags from the AppError subclass if available.
 */
export async function captureError(err: unknown): Promise<void> {
  if (!initialized || !sentryModule) return;
  if (!shouldCaptureToSentry(err)) return;
  try {
    // Tag with severity + code when available (AppError subclasses).
    if (err && typeof err === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = err as any;
      if (typeof e.severity === 'string') {
        sentryModule.setTag('severity', e.severity);
      }
      if (typeof e.code === 'string') {
        sentryModule.setTag('code', e.code);
      }
      if (typeof e.sentryLevel === 'string') {
        sentryModule.captureException(err, { level: e.sentryLevel });
        return;
      }
    }
    sentryModule.captureException(err);
  } catch {
    // Swallow — telemetry must never block the CLI.
  }
}

/**
 * Drain Sentry buffer + PostHog queue (each with a 2s timeout) then exit.
 * Replaces direct `process.exit()` at the top-level main() boundary +
 * unhandledRejection handler.
 *
 * Phase 125 (CONTEXT.md §125-02 must_haves): both vendors are awaited in
 * PARALLEL via Promise.allSettled — neither rejection blocks the other,
 * neither vendor's slow drain serializes behind the other. If neither SDK
 * is initialized this is essentially a no-op + immediate exit (zero added
 * latency on the happy path for telemetry-off users).
 */
export async function flushAndExit(exitCode: number): Promise<never> {
  await Promise.allSettled([
    (async (): Promise<void> => {
      if (initialized && sentryModule) {
        try {
          await sentryModule.close(2000);
        } catch {
          // Swallow — never block exit.
        }
      }
    })(),
    shutdownPostHog(2000),
  ]);
  process.exit(exitCode);
  // Unreachable after process.exit; satisfies the `Promise<never>` return type
  // for TS without a raw `throw new Error` (AppError discipline — see the
  // monorepo CLAUDE.md rule the CLI mirrors).
  return undefined as never;
}

// Test-only helpers — allow the sentry-init + telemetry-consent specs to
// reset module-level state between cases. NOT part of the production API.
export function __resetForTests(): void {
  initialized = false;
  initAttempted = false;
  sentryModule = null;
}
export function __isInitializedForTests(): boolean {
  return initialized;
}
