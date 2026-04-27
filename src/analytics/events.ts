// Phase 125 Plan 01 Task 2 — CLI-side mirror of the typed event registry.
//
// Byte-mirror of packages/observability/src/analytics/events.ts in the
// HookMyApp monorepo. Edit the monorepo copy then re-mirror here; the
// per-side drift test (src/__tests__/manifest-drift.test.ts) walks the
// JSON manifest + this file and fails CI if either copy drifts.
//
// No runtime emit() lives here — the CLI wires its own posthog-node client
// in a subsequent Plan (125-02) and calls `capture()` directly with the
// EventName / EventProperties types below as its compile-time gate.
//
// Every PostHog event emitted across the stack (CLI, sandbox-proxy, forwarder,
// ops-worker, frontend, backend) is declared here with its EVENT-SPECIFIC
// property shape. The emitter merges the canonical baseline
// (`site`, `environment`, `workspace_id`, `days_since_signup` — CONTEXT.md §16)
// onto every capture at runtime — callers pass only the event-specific bits
// below.
//
// Note: pre-existing Phase 113 `first_webhook_forwarded` and Phase 126
// `sandbox_session_created` events are declared here too — Phase 125 makes
// the typed emitter the single source of truth; their existing emit sites
// in forwarder migrate to `emit()` in Plan 04.

// ---------------------------------------------------------------------------
// Canonical baseline (CONTEXT.md §16) — runtime-only. NOT part of per-event
// property types; merged in by the emitter via `getBaselineProperties()`.
// ---------------------------------------------------------------------------

export interface BaselineProperties {
  site: 'marketing' | 'app' | 'cli' | 'sandbox-proxy' | 'forwarder' | 'ops-worker';
  environment: 'staging' | 'production' | 'local';
  /**
   * Phase 117 workspace publicId (`ws_...`). Optional — omitted on events
   * that fire before the user has resolved a workspace (e.g. `cli_first_run`,
   * marketing pageviews).
   */
  workspace_id?: string;
  /**
   * Days since the person's `$set_once` `signup_date`. `null` pre-signup.
   * Computed at emit time by `super-properties.ts`.
   */
  days_since_signup: number | null;
}

// ---------------------------------------------------------------------------
// 7 CLI events — CONTEXT.md §5. Every CLI event carries `cli_version`
// (CONTEXT.md §16 CLI-only baseline) on its event-specific props — the
// emitter baseline stays cross-surface.
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

/** Phase 108 CLI-108-04 exit-code table: 0=ok, 1–6=error tiers. */
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
 * missing. NOT for fine-grained activity tracking — that's `_started` +
 * `_stopped` with `duration_seconds`.
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
// 1 sandbox-proxy event — CONTEXT.md §6
// ---------------------------------------------------------------------------

export interface SandboxMessageSentProps {
  workspace_id: string;
  message_type: string;
  meta_status: number;
}

// ---------------------------------------------------------------------------
// 5 forwarder events — CONTEXT.md §7 (3 new + 2 pre-existing from Phase 113/126)
// ---------------------------------------------------------------------------

export interface SandboxMessageReceivedProps {
  workspace_id: string;
  session_public_id: string;
}

export interface SandboxMessageForwardedProps {
  workspace_id: string;
  session_public_id: string;
  forward_duration_ms: number;
}

export interface WebhookForwardedProps {
  workspace_id: string;
  path: 'production' | 'sandbox';
  destination_url_hash: string;
  forward_duration_ms: number;
}

/** Phase 113 one-time-per-workspace milestone; shape preserved verbatim. */
export interface FirstWebhookForwardedProps {
  workspace_id: string;
}

/** Phase 126 one-time-per-session event; shape preserved verbatim. */
export interface SandboxSessionCreatedProps {
  workspace_id: string;
  session_public_id: string;
}

// ---------------------------------------------------------------------------
// 12 app frontend / backend events — CONTEXT.md §8
// ---------------------------------------------------------------------------

// Quick Start cluster (6) — anchored on `/w/:ws/sandbox/quick-start`.
export interface QuickstartCodeCopiedProps {
  workspace_id: string;
}
export interface QuickstartPhoneCopiedProps {
  workspace_id: string;
}
export interface QuickstartWhatsappLinkOpenedProps {
  workspace_id: string;
}
export interface QuickstartSessionSelectedProps {
  workspace_id: string;
  session_public_id: string;
}
export interface QuickstartBindNewNumberClickedProps {
  workspace_id: string;
}
export interface SandboxInstructionsCopiedProps {
  workspace_id: string;
  session_public_id?: string;
}

// Other named app events (6).
export interface WorkspaceSwitchedProps {
  from_workspace_id: string | null;
  to_workspace_id: string;
}
export interface InviteAcceptedProps {
  workspace_id: string;
}
export interface WebhookTestFiredProps {
  workspace_id: string;
  result: 'success' | 'fail';
  status_code: number;
}
export interface PlanCheckoutCompletedProps {
  workspace_id: string;
  plan: string;
}
/**
 * Server-side event — emitted by backend on Stripe `checkout.session.expired`
 * webhook (browser can't observe abandonment).
 */
export interface PlanCheckoutAbandonedProps {
  workspace_id: string;
  plan: string;
}
export interface ApiErrorShownProps {
  workspace_id?: string;
  error_code: string;
  status_code?: number;
}

// ---------------------------------------------------------------------------
// Event-name → property-shape map (compile-time gate for `emit()`)
// ---------------------------------------------------------------------------

export interface EventRegistry {
  // CLI (7)
  cli_first_run: CliFirstRunProps;
  cli_logged_in: CliLoggedInProps;
  cli_command_invoked: CliCommandInvokedProps;
  cli_sandbox_listen_started: CliSandboxListenStartedProps;
  cli_sandbox_listen_liveness: CliSandboxListenLivenessProps;
  cli_sandbox_listen_stopped: CliSandboxListenStoppedProps;
  cli_error_shown: CliErrorShownProps;
  // sandbox-proxy (1)
  sandbox_message_sent: SandboxMessageSentProps;
  // forwarder (5 — 3 new + 2 pre-existing)
  sandbox_message_received: SandboxMessageReceivedProps;
  sandbox_message_forwarded: SandboxMessageForwardedProps;
  webhook_forwarded: WebhookForwardedProps;
  first_webhook_forwarded: FirstWebhookForwardedProps;
  sandbox_session_created: SandboxSessionCreatedProps;
  // app frontend + backend (12)
  quickstart_code_copied: QuickstartCodeCopiedProps;
  quickstart_phone_copied: QuickstartPhoneCopiedProps;
  quickstart_whatsapp_link_opened: QuickstartWhatsappLinkOpenedProps;
  quickstart_session_selected: QuickstartSessionSelectedProps;
  quickstart_bind_new_number_clicked: QuickstartBindNewNumberClickedProps;
  sandbox_instructions_copied: SandboxInstructionsCopiedProps;
  workspace_switched: WorkspaceSwitchedProps;
  invite_accepted: InviteAcceptedProps;
  webhook_test_fired: WebhookTestFiredProps;
  plan_checkout_completed: PlanCheckoutCompletedProps;
  plan_checkout_abandoned: PlanCheckoutAbandonedProps;
  api_error_shown: ApiErrorShownProps;
}

export type EventName = keyof EventRegistry;
export type EventProperties<E extends EventName> = EventRegistry[E];

/**
 * Runtime-visible array of every event name.
 *
 * Interfaces erase at runtime, so drift tests + sanity checks that need to
 * walk the registry at test time MUST walk this const instead of the
 * `EventRegistry` interface. `as const satisfies` locks:
 *   1. The array is readonly (treated as a literal tuple of names).
 *   2. Every name MUST be a valid `EventName` (compile-time registry check).
 *
 * Mirrored byte-for-byte into `/Users/ordvir/COD/cli/src/analytics/events.ts`.
 */
export const EVENT_NAMES_RUNTIME = [
  // CLI (7)
  'cli_first_run',
  'cli_logged_in',
  'cli_command_invoked',
  'cli_sandbox_listen_started',
  'cli_sandbox_listen_liveness',
  'cli_sandbox_listen_stopped',
  'cli_error_shown',
  // sandbox-proxy (1)
  'sandbox_message_sent',
  // forwarder (5)
  'sandbox_message_received',
  'sandbox_message_forwarded',
  'webhook_forwarded',
  'first_webhook_forwarded',
  'sandbox_session_created',
  // app frontend + backend (12)
  'quickstart_code_copied',
  'quickstart_phone_copied',
  'quickstart_whatsapp_link_opened',
  'quickstart_session_selected',
  'quickstart_bind_new_number_clicked',
  'sandbox_instructions_copied',
  'workspace_switched',
  'invite_accepted',
  'webhook_test_fired',
  'plan_checkout_completed',
  'plan_checkout_abandoned',
  'api_error_shown',
] as const satisfies readonly EventName[];

export type RuntimeEventName = (typeof EVENT_NAMES_RUNTIME)[number];
