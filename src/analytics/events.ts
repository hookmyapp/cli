// CLI-side typed event registry — scoped subset of the monorepo's full
// registry at packages/observability/src/analytics/events.ts.
//
// History: from Phase 125 through Phase 130 this file was a byte-for-byte
// mirror of the monorepo registry. That coupled CLI to every monorepo event
// addition (web, web-api, demo, marketing) even though CLI emits only the
// 7 `cli_*` events. With monorepo's surface growing (frontend + backend +
// workers + web + web-api + demo funnel = 27 events CLI never fires) the
// mirror became pure overhead.
//
// New invariant: this file declares only events the CLI binary actually
// emits — the 7 `cli_*` events. The cross-repo drift test in monorepo
// (packages/observability/src/analytics/__tests__/manifest-drift.spec.ts)
// asserts CLI's manifest is a STRUCTURAL SUBSET of monorepo's manifest:
// every event declared here must exist in the monorepo with the same
// property set. Monorepo can grow freely; CLI is protected from accidental
// deletion or rename of a `cli_*` event the binary depends on.
//
// To add a new CLI event: declare it in BOTH this file AND
// packages/observability/src/analytics/events.ts in the monorepo, with
// matching property shapes. Run both repos' `pnpm test` to confirm the
// subset assertion holds.
//
// `BaselineProperties` is mirrored here (rather than imported from a shared
// package) because CLI is bundled by esbuild into a single binary with
// sigstore provenance — adding an npm dep on `@hookmyapp/observability`
// would either pollute the install graph with peer deps the CLI doesn't
// need, or require publishing observability without provenance from the
// private monorepo. Vendoring this ~20-line type is cheaper.

// ---------------------------------------------------------------------------
// Canonical baseline — runtime-only. NOT part of per-event property types;
// merged in by the emitter at runtime.
// ---------------------------------------------------------------------------

export interface BaselineProperties {
  site: 'marketing' | 'app' | 'cli' | 'sandbox-proxy' | 'forwarder' | 'ops-worker' | 'web' | 'web-api';
  environment: 'staging' | 'production' | 'local';
  /**
   * Workspace publicId (`ws_...`). Optional — omitted on events that fire
   * before the user has resolved a workspace (e.g. `cli_first_run`).
   */
  workspace_id?: string;
  /**
   * Days since the person's `$set_once` `signup_date`. `null` pre-signup.
   * Computed at emit time by the CLI's super-properties resolver.
   */
  days_since_signup: number | null;
}

// ---------------------------------------------------------------------------
// 7 CLI events. Every CLI event carries `cli_version` on its event-specific
// props — the emitter baseline stays cross-surface.
// ---------------------------------------------------------------------------

export interface CliFirstRunProps {
  cli_version: string;
  node_version: string;
  platform: NodeJS.Platform;
}

export interface CliLoggedInProps {
  cli_version: string;
  login_method: 'device' | 'code';
  workspace_public_id?: string;
}

/** CLI-108-04 exit-code table: 0=ok, 1–6=error tiers. */
export type CliExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CliCommandInvokedProps {
  cli_version: string;
  command: string;
  subcommand: string | null;
  exit_code: CliExitCode;
  duration_ms: number;
  node_version: string;
  platform: NodeJS.Platform;
}

export interface CliSandboxListenStartedProps {
  cli_version: string;
  session_public_id: string;
  workspace_public_id: string;
}

/**
 * Coarse liveness ping (every 2h) — backstop for sessions where
 * `cli_sandbox_listen_stopped` never fires (kill -9, laptop sleep, OOM,
 * network drop). Lets dashboards upper-bound session duration when stop is
 * missing.
 */
export interface CliSandboxListenLivenessProps {
  cli_version: string;
  session_public_id: string;
  elapsed_seconds: number;
}

/**
 * Fires once per session on clean exit (SIGINT/SIGTERM). Carries the full
 * session duration so dashboards compute "active sandbox time" without
 * counting heartbeats. Cloudflared-died and other unclean exits do NOT
 * emit this — the 2h liveness ping is the duration backstop there.
 */
export interface CliSandboxListenStoppedProps {
  cli_version: string;
  session_public_id: string;
  duration_seconds: number;
}

export interface CliErrorShownProps {
  cli_version: string;
  error_code: string;
  exit_code: CliExitCode;
  command: string;
}

// ---------------------------------------------------------------------------
// Event-name → property-shape map (compile-time gate for `emit()`)
// ---------------------------------------------------------------------------

export interface EventRegistry {
  cli_first_run: CliFirstRunProps;
  cli_logged_in: CliLoggedInProps;
  cli_command_invoked: CliCommandInvokedProps;
  cli_sandbox_listen_started: CliSandboxListenStartedProps;
  cli_sandbox_listen_liveness: CliSandboxListenLivenessProps;
  cli_sandbox_listen_stopped: CliSandboxListenStoppedProps;
  cli_error_shown: CliErrorShownProps;
}

export type EventName = keyof EventRegistry;
export type EventProperties<E extends EventName> = EventRegistry[E];

/**
 * Runtime-visible array of every event name CLI emits.
 *
 * Interfaces erase at runtime, so drift tests + sanity checks that need to
 * walk the registry at test time MUST walk this const instead of the
 * `EventRegistry` interface. `as const satisfies` locks:
 *   1. The array is readonly (treated as a literal tuple of names).
 *   2. Every name MUST be a valid `EventName` (compile-time registry check).
 */
export const EVENT_NAMES_RUNTIME = [
  'cli_first_run',
  'cli_logged_in',
  'cli_command_invoked',
  'cli_sandbox_listen_started',
  'cli_sandbox_listen_liveness',
  'cli_sandbox_listen_stopped',
  'cli_error_shown',
] as const satisfies readonly EventName[];

export type RuntimeEventName = (typeof EVENT_NAMES_RUNTIME)[number];
