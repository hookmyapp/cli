// Phase 125 Plan 02 — CLI PostHog wiring.
//
// Mirrors `sentry.ts` shape verbatim so observability stays one consistent
// mental model. Key contracts:
//
// 1. LAZY INIT. `initPostHogLazy()` only dynamic-imports `posthog-node` when
//    BOTH `isTelemetryEnabled()` AND a token is baked. Telemetry-off users
//    pay zero cold-start cost.
//
// 2. SHORT-LIVED PROCESS PATTERN (RESEARCH §Pattern 1). The CLI is short-
//    lived (most commands exit in <1s), so we configure `flushAt: 1` +
//    `flushInterval: 0`. Every capture is queued for immediate send; the
//    2s `shutdown(2000)` drain at exit picks up the trailing in-flight
//    requests. Without this, posthog-node's default 20-event-or-10s
//    batching loses every CLI capture.
//
// 3. SINGLE KILL-SWITCH (CONTEXT.md §4). `isTelemetryEnabled()` is the same
//    function `sentry.ts` already calls — `HOOKMYAPP_TELEMETRY=off` OR
//    `hookmyapp config set telemetry off` kills BOTH SDKs. No vendor-
//    specific flag.
//
// 4. ALIAS DIRECTION (RESEARCH §Pitfall 1). `posthogAliasAndIdentify()` calls
//    `client.alias({ distinctId: workosSub, alias: machineId })` — distinctId
//    is the canonical user, alias is the side identifier we want stitched in.
//    Reversing the args silently merges the user profile into the machine
//    forever; we have a unit test pinning the direction.
//
// 5. ONCE-PER-(MACHINE,USER) ALIAS (CONTEXT.md §3). The `posthogAliasedUsers`
//    array in config.json blocks repeated alias calls for the same sub on
//    the same machine; a different sub on the same machine still aliases
//    once for that pair (handles shared dev machines + identity switches).
//
// 6. FAIL-OPEN. Every emit/alias is wrapped in try/catch. Telemetry must
//    NEVER block the CLI. Errors go to stderr (visible during dev) but are
//    swallowed otherwise.

import type { PostHog as PostHogType } from 'posthog-node';
import { isTelemetryEnabled } from './telemetry.js';
import { decodeJwtSub } from './jwt-light.js';
import {
  readPosthogConfig,
  writePosthogConfig,
  readActiveWorkspacePublicId,
} from '../config/index.js';
import { resolveEnv } from '../config/env-profiles.js';
import { nanoid } from 'nanoid';
import type { EventName, EventProperties } from '../analytics/events.js';

// Module-level state — one client per process, one init attempt.
// `undefined` = not yet attempted; `null` = attempted + decided to no-op;
// `PostHogType` = live client.
let clientInstance: PostHogType | null | undefined = undefined;

/**
 * Resolve the baked PostHog token. esbuild rewrites
 * `process.env.HOOKMYAPP_POSTHOG_TOKEN` at build time (see build.mjs); dev
 * runs (`tsx src/index.ts`) read the env var at runtime — empty token →
 * lazy init no-ops.
 */
function resolveToken(): string | undefined {
  const t = process.env.HOOKMYAPP_POSTHOG_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

function resolveHost(): string {
  const h = process.env.HOOKMYAPP_POSTHOG_HOST;
  return h && h.length > 0 ? h : 'https://us.i.posthog.com';
}

/**
 * Lazy PostHog initialization. Safe to call repeatedly — the second call
 * returns the same instance (or null) without re-attempting. No-op when:
 *   - `HOOKMYAPP_TELEMETRY=off` env var is set
 *   - persisted `telemetry: 'off'` in config.json
 *   - no token is baked into the binary (dev build / token unset)
 */
export async function initPostHogLazy(): Promise<PostHogType | null> {
  if (clientInstance !== undefined) return clientInstance;

  if (!isTelemetryEnabled()) {
    clientInstance = null;
    return null;
  }
  const token = resolveToken();
  if (!token) {
    clientInstance = null;
    return null;
  }

  try {
    const { PostHog } = await import('posthog-node');
    const host = resolveHost();
    // Short-lived process pattern (RESEARCH §Pattern 1):
    //   flushAt: 1       → queue size of 1 → every capture sends immediately
    //   flushInterval: 0 → disable the periodic batcher
    // Combined with the 2s `shutdown(2000)` drain at exit (see flushAndExit
    // in sentry.ts), no event is left in the queue on a clean exit.
    clientInstance = new PostHog(token, { host, flushAt: 1, flushInterval: 0 });
    clientInstance.on('error', (err: Error) => {
      // Surface to stderr so dev sees it; never throw — fail-open.
      process.stderr.write(`[posthog] ${err.message}\n`);
    });
    return clientInstance;
  } catch (err) {
    // Swallow init errors. Observability must NEVER break the CLI.
    process.stderr.write(`[posthog.init] ${(err as Error).message}\n`);
    clientInstance = null;
    return null;
  }
}

/**
 * Drain the PostHog queue with a 2s timeout. Called from
 * `sentry.flushAndExit` in parallel with `Sentry.flush(2000)` via
 * Promise.allSettled — neither vendor's failure can block the other.
 */
export async function shutdownPostHog(timeoutMs = 2000): Promise<void> {
  if (!clientInstance) return;
  try {
    await clientInstance.shutdown(timeoutMs);
  } catch {
    // Swallow — exit must never block on observability.
  }
}

/** CLI release identifier baked at build time (esbuild define). */
export function getCliVersion(): string {
  return process.env.HOOKMYAPP_CLI_RELEASE ?? 'dev';
}

/**
 * Generate (and persist) the per-machine UUID used as the anonymous
 * `distinct_id` for pre-login captures. Subsequent calls return the same id
 * — the value persists in `~/.hookmyapp/config.json` forever once written,
 * so multi-day installs stay attributable across sessions.
 */
export function getOrCreateMachineId(): string {
  const cfg = readPosthogConfig();
  if (cfg.posthogDistinctId) return cfg.posthogDistinctId;
  const id = nanoid();
  writePosthogConfig({ posthogDistinctId: id });
  return id;
}

/**
 * Resolve the runtime `distinct_id`. Prefer the last successfully-resolved
 * WorkOS sub (so post-login emits land on the user profile the app +
 * marketing already populated); fall back to the machine id for pre-login
 * captures.
 */
export function getDistinctId(): string {
  const cfg = readPosthogConfig();
  return cfg.lastWorkosSub ?? getOrCreateMachineId();
}

/** Resolve the canonical `environment` baseline property. */
function resolveCliEnvironment(): 'staging' | 'production' | 'local' {
  try {
    return resolveEnv();
  } catch {
    return 'production';
  }
}

interface BaselineRuntime {
  site: 'cli';
  environment: 'staging' | 'production' | 'local';
  workspace_id?: string;
  days_since_signup: number | null;
  cli_version: string;
}

function buildBaseline(): BaselineRuntime {
  const cfg = readPosthogConfig();
  const workspaceId = readActiveWorkspacePublicId();
  const days = cfg.signupDate
    ? Math.floor(
        (Date.now() - new Date(cfg.signupDate).getTime()) / 86_400_000,
      )
    : null;
  return {
    site: 'cli',
    environment: resolveCliEnvironment(),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    days_since_signup: days,
    cli_version: getCliVersion(),
  };
}

/**
 * Typed event emitter. Compile-time enforces:
 *   - `event` must be a known `EventName`
 *   - `props` must match `EventProperties<event>`
 *
 * Runtime contract: telemetry-off + no-token paths return without doing
 * anything (no module load, no HTTP). All exceptions are swallowed and
 * logged to stderr so capture errors never propagate up to user code.
 */
export async function emit<E extends EventName>(
  event: E,
  props: EventProperties<E>,
): Promise<void> {
  try {
    const client = await initPostHogLazy();
    if (!client) return;
    const baseline = buildBaseline();
    client.capture({
      event,
      distinctId: getDistinctId(),
      properties: { ...baseline, ...props },
    });
  } catch (err) {
    process.stderr.write(`[posthog.emit:${event}] ${(err as Error).message}\n`);
  }
}

/**
 * Skip-list filter for `cli_command_invoked` (CONTEXT.md §5). Help / version
 * / pure-meta commands are no-ops on the user's mental model — emitting
 * `cli_command_invoked` for them inflates volume + skews the funnel.
 *
 * Exported (vs. file-private) so the unit tests pin the contract directly
 * without going through the full `runWithInstrumentation` wrapper.
 */
const SKIP_EVENTS_FOR = new Set(['help', '--help', '-h', '--version', '-v']);
export function shouldEmitCommandInvoked(
  command: string,
  subcommand: string | null,
): boolean {
  if (SKIP_EVENTS_FOR.has(command)) return false;
  if (subcommand && SKIP_EVENTS_FOR.has(subcommand)) return false;
  return true;
}

/**
 * Emit `cli_first_run` once on the first-ever invocation per machine.
 * Detection: `posthogDistinctId` is unset → first run. The act of emitting
 * persists the machine id (via `getOrCreateMachineId`), so subsequent
 * invocations short-circuit on the existence check.
 */
export async function maybeEmitFirstRun(): Promise<void> {
  const cfg = readPosthogConfig();
  if (cfg.posthogDistinctId) return; // already ran before
  // Side effect — persist the machine id BEFORE emitting so the emit's
  // distinctId resolution sees it.
  getOrCreateMachineId();
  await emit('cli_first_run', {
    cli_version: getCliVersion(),
    node_version: process.version,
    platform: process.platform,
  });
}

/**
 * Once-per-(machine, user) alias. Called from auth/login.ts after both the
 * device-flow and `--code` bootstrap paths persist credentials.
 *
 *   Direction (RESEARCH §Pitfall 1):
 *     client.alias({ distinctId: workosSub, alias: machineId })
 *
 *   workosSub is the canonical user identity; machineId is the side
 *   identifier we want PostHog to merge in. Reversing collapses the user
 *   into the machine — never do that.
 *
 * Also emits `cli_logged_in` so the funnel sees the login event regardless
 * of whether this was the first or Nth login on this machine.
 */
export async function posthogAliasAndIdentify(opts: {
  jwt: string | null;
  workosSub?: string;
  loginMethod: 'device' | 'code';
  email?: string;
  name?: string;
}): Promise<void> {
  try {
    const client = await initPostHogLazy();
    if (!client) return;

    const sub =
      opts.workosSub ?? (opts.jwt ? decodeJwtSub(opts.jwt) || null : null);
    if (!sub) return;

    const cfg = readPosthogConfig();
    const machineId = getOrCreateMachineId();
    const aliased = cfg.posthogAliasedUsers ?? [];

    if (!aliased.includes(sub)) {
      // First time we see this (machine, user) pair — alias once.
      client.alias({ distinctId: sub, alias: machineId });
      writePosthogConfig({
        lastWorkosSub: sub,
        posthogAliasedUsers: [...aliased, sub],
      });
    } else {
      // Already aliased — just update lastWorkosSub so subsequent emits use
      // the user-scoped distinctId.
      writePosthogConfig({ lastWorkosSub: sub });
    }

    // Phase 125 follow-up — attach email + name to the PostHog person so the
    // Persons UI displays the user identity for CLI events without requiring
    // a frontend visit. Mirrors workspace-context.tsx's identify shape; $set
    // overwrites every login (email/name can drift). No-op when WorkOS didn't
    // return them.
    if (opts.email || opts.name) {
      const props: Record<string, unknown> = {};
      if (opts.email) props.email = opts.email;
      if (opts.name) props.name = opts.name;
      const $set: Record<string, unknown> = {};
      if (opts.email) $set.email = opts.email;
      if (opts.name) $set.name = opts.name;
      props.$set = $set;
      client.identify({ distinctId: sub, properties: props });
    }

    // Workspace publicId may already be persisted by login.ts (it writes
    // activeWorkspaceId before calling here), so buildBaseline picks it up
    // automatically — no need to thread it through emit() args.
    await emit('cli_logged_in', {
      cli_version: getCliVersion(),
      login_method: opts.loginMethod,
      workspace_public_id: readActiveWorkspacePublicId(),
    });
  } catch (err) {
    process.stderr.write(`[posthog.alias] ${(err as Error).message}\n`);
  }
}

// Test-only helpers — let the unit tests reset module state between cases.
// NOT part of the production API.
export function __resetForTests(): void {
  clientInstance = undefined;
}
export function __isInitializedForTests(): boolean {
  return clientInstance !== null && clientInstance !== undefined;
}
