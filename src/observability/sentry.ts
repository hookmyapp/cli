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

import { isTelemetryEnabled, maybePrintFirstRunDisclosure } from './telemetry.js';
import { decodeJwtSub } from './jwt-light.js';

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
    sentryModule.init({
      dsn,
      release: resolveRelease(),
      environment: resolveEnvironment(),
      enableLogs: true,
      // No tracing in CLI — we're short-lived, don't ship span data.
      tracesSampleRate: 0,
    });
    sentryModule.setTag('service', 'cli');
    initialized = true;
    maybePrintFirstRunDisclosure();
  } catch {
    // Swallow all init errors. Telemetry must NEVER break the CLI.
    sentryModule = null;
    initialized = false;
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
  const creds = readCredentials();
  if (!creds?.accessToken) return;

  const sub = decodeJwtSub(creds.accessToken);
  if (!sub) return;
  sentryModule.setUser({ id: sub });
}

/**
 * Decide whether to forward an error to Sentry.
 *
 * - Local validation/auth/permission errors from the CLI → captured (they
 *   represent unexpected CLI-side failures worth tracking).
 * - NetworkError (pre-backend fetch failures) → captured (DNS / offline;
 *   might indicate a bug in URL handling or env resolution).
 * - ApiError (backend returned non-2xx) → NOT captured (backend already has
 *   it). Per CONTEXT.md §single-capture-per-error.
 * - AuthError + PermissionError + ValidationError + ConflictError +
 *   RateLimitError when they wrap a backend response → NOT captured (backend
 *   captured them already with full request context).
 *
 * Simple heuristic: if the error has a non-undefined `statusCode` attribute
 * (meaning it wraps an HTTP response), don't double-capture. Otherwise, do.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function shouldCaptureToSentry(err: any): boolean {
  if (err == null) return false;
  // NetworkError is CLI-local (no response from backend). Capture it.
  if (err?.code === 'NETWORK_ERROR') return true;
  // Any error that carries a statusCode came from a backend response —
  // backend already captured it.
  if (typeof err === 'object' && 'statusCode' in err && err.statusCode !== undefined) {
    return false;
  }
  // Everything else — including AppError subclasses thrown locally — captures.
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
 * Drain Sentry buffer (2 s timeout) then exit. Replaces direct `process.exit()`
 * at the top-level main() boundary + unhandledRejection handler.
 *
 * If Sentry isn't initialized, exits immediately — zero added latency on the
 * happy path for telemetry-off users.
 */
export async function flushAndExit(exitCode: number): Promise<never> {
  if (initialized && sentryModule) {
    try {
      await sentryModule.close(2000);
    } catch {
      // Swallow — never block exit.
    }
  }
  process.exit(exitCode);
  // Unreachable; satisfies the `Promise<never>` return type for TS.
  throw new Error('unreachable');
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
