# CLI channel listen: HookMyAppCLI as the default destination

**Status:** approved (2026-05-15)
**Scope:** Two repositories. Monorepo (`/Users/ordvir/COD/hookmyapp`) — `backend/`, `forwarder/`, `frontend/`, `ops-worker/`, `terraform/`, shared Prisma schema. CLI repo (`/Users/ordvir/COD/cli`, published as `@gethookmyapp/cli`) — new `channels listen` command. One new Cloudflare zone (`hookmyapp-listen.com`).
**Target release:** TBD (next CLI minor + paired backend deploy).

## Problem

The CLI's `sandbox listen` command already solves "give a developer running
code on localhost a real, public, secure WhatsApp webhook destination" — by
spawning `cloudflared` and provisioning a per-session Cloudflare Tunnel that
the forwarder routes inbound webhooks through.

But it only works for the **shared sandbox WABA**. The moment a user
onboards a real WhatsApp Business number and wants to keep building locally
— including agentic / self-hosted use cases like OpenClaude installed on a
personal laptop or friend's NUC — they hit a wall: their real channel has
to forward to an HTTPS URL, and they don't have one.

We've already solved this problem once. We're going to solve it again, for
real channels, by reusing the same mechanism.

## Goals

- A user with an onboarded WABA channel can run `hookmyapp channels listen`
  and receive webhooks for that channel on `localhost`. Same UX as
  `sandbox listen` — same picker, same heartbeat, same Ctrl-C semantics.
- The channel detail page shows **HookMyAppCLI** as the default destination
  for every channel. Users override that default by typing a webhook URL;
  clicking "Go back to HookMyAppCLI" erases the URL and restores the
  default.
- Tunnels can stay up indefinitely (24/7 use is supported and expected — it
  is the OpenClaude-style use case).

## Non-goals

- **Outbound proxying.** Real channels send messages to Meta directly using
  the user's own access token. This feature touches only the inbound
  webhook path. No analog of `sandbox-proxy` is built.
- **Offline buffering / message queueing.** When the CLI is offline and a
  webhook arrives, the forwarder returns 5xx and Meta retries — same
  behavior as today's sandbox tunnel and today's configured webhook URL.
  There is no buffer, no fallback URL, no replay.
- **A new pricing tier or gating.** Free for every paying workspace, same
  as the sandbox. If abuse becomes a real concern later, gating can be
  added then.
- **Sandbox zone rename.** `hookmyapp-sandbox.com` continues to host
  sandbox tunnels. Migrating sandbox to a subdomain of the new listen zone
  is cosmetic refactoring of a working production system, explicitly
  out-of-scope for this feature. Schedulable as a separate housekeeping
  phase later if desired.

## Decisions

### D1. The architecture is a clone of the sandbox tunnel architecture.

The sandbox tunnel flow (CF Tunnel + DNS CNAME + CF Access service-token
policy + `cloudflared` in token mode + heartbeat + reaper) is reused
verbatim. The forwarder resolves a destination from the channel's
configured URL when set, otherwise from the channel's active tunnel
fields (`hostname` + `lastHeartbeatAt`) when present — and forwards to
whatever URL that resolution produces (see D2 for the precedence rule and
D5 for the destination-allowlist that gates CF Access header injection).

The only genuinely new pieces are the channel-side endpoints, the channel
picker in the CLI, and the dashboard's "HookMyAppCLI as default destination"
pill.

**Rejected alternative:** building a separate, simpler relay (WebSocket
broker, ngrok-style account). Reusing the existing CF Tunnel + Access stack
costs us nothing operationally, keeps the security envelope consistent
between sandbox and prod, and means we have one runtime to debug — not two.

### D2. HookMyAppCLI is the *default* destination, not a *mode*.

Mental model: every channel has one nullable destination field
(`webhookUrl`). `null` means default = HookMyAppCLI. A user types a URL to
override; they click "Go back to HookMyAppCLI" to clear the URL and return
to the default.

This is the same mental model the sandbox-sessions table already uses, and
it avoids a `destinationKind` discriminator column entirely. The
forwarder's precedence becomes a single rule: if a URL is set, forward
there; otherwise, if a CLI is currently bound to this channel, forward to
its tunnel; otherwise, no destination — return 5xx and let Meta retry.

**WebhookConfig lifecycle (today vs after this change).** Today
`Channel.webhookConfig` is optional and `WebhookConfig.verifyToken` is
required — a channel with no configured webhook simply has no row, and
the forwarder treats `!webhookConfig` as the `no_webhook_config` routing
decision. Two viable models for this feature:

- **Model A (lazy row):** `WebhookConfig` stays optional. The first CLI
  `tunnel/start` call (or first dashboard URL save) creates the row with
  a random `verifyToken` if missing. Channels that have never been
  configured stay row-less. UI default state ("HookMyAppCLI" pill) is
  shown for both "no row" and "row with `webhookUrl=null`". Forwarder
  precedence: row missing → no destination (current `no_webhook_config`
  branch); row with `webhookUrl=null` + active tunnel → tunnel; row with
  `webhookUrl` set → URL.

- **Model B (eager row):** Migration backfills a `WebhookConfig` row for
  every existing channel with `webhookUrl=null` and a random
  `verifyToken`. Forwarder always finds a row; precedence collapses to
  "URL else tunnel else nothing." Heavier migration, but the forwarder
  code path is simpler.

**Choice: Model A.** It avoids touching every existing channel's row at
migration time, keeps the forwarder's `no_webhook_config` branch valid
(channels with neither URL nor active CLI legitimately have no
destination), and matches the natural lifecycle — a row appears the
moment a user does something destination-related.

**Rejected alternative:** storing both the user's URL and the CLI tunnel
state side-by-side with a discriminator flag and a `restoreWebhookUrl`
field for flip-back. The user-facing behavior — "if I want my URL back I'll
re-enter it" — is simple enough that preserving stale URL state across
mode flips adds complexity without value.

### D3. Setting a URL while the CLI is listening tears down the tunnel.

Two reasonable options for the edge case where the user pastes a webhook
URL into the dashboard while a CLI is mid-listen:

1. Reject the URL update with "stop your CLI first" (strict).
2. Accept the URL, tear down the active tunnel server-side, and the CLI
   exits cleanly on its next heartbeat with a clear message.

**Choice: option 2.** URL wins when set is the simpler, more direct user
intent. The CLI process is the cheap, recoverable end of the system —
forcing the user to stop it manually before changing dashboard state is
needless friction.

**Heartbeat contract change.** Today the sandbox heartbeat endpoint returns
204 No Content and the service body only updates `lastHeartbeatAt` — there
is no way to signal back to a running CLI that its tunnel has been torn
down server-side. For this feature, the channel heartbeat endpoint must
return a terminal error when the row's tunnel fields have been cleared
(URL set, reaper swept, explicit Stop call). Specifically: `410 Gone` with
a stable AppError code `CHANNEL_TUNNEL_RECLAIMED` and a `userMessage`
explaining why (e.g., "This channel's destination was changed to a webhook
URL; the CLI listener has been stopped"). The CLI catches that code, prints
the user message, and exits 0.

Sandbox heartbeat semantics are unchanged — the contract addition is
channel-side only. If sandbox ever needs the same teardown-detection later,
it can adopt the same code by extension.

### D4. New Cloudflare zone `hookmyapp-listen.com`.

We are NOT reusing `hookmyapp-sandbox.com` for real-channel CLI tunnels.
"Sandbox" in a hostname for a paying customer's production channel is
semantically wrong — it will mislead future operators, support, and any log
or screenshot that escapes containment.

**Naming rationale (rejected alternatives):**
- `hookmyapp-cli.com` — too broad. The CLI does many things; this zone is
  specifically for inbound endpoint termination.
- `hookmyapp-tunnel.com` — leaks implementation. Domains are sticky; if we
  ever swap CF Tunnels for something else the name becomes a lie.
- A subdomain of the main `hookmyapp.com` zone — pollutes the primary zone
  with per-tunnel DNS records and would eventually compete with our app's
  records for the zone's record-limit ceiling.

**Chosen:** `hookmyapp-listen.com`. Function-named ("listen" matches the
CLI verb and the user mental model), implementation-agnostic, parallel to
the existing `hookmyapp-sandbox.com` convention. Bought on 2026-05-15 for
$10.46/yr.

### D5. CF Access security envelope is identical to sandbox.

Each tunnel CNAME is created with `proxied=true`, putting the request
through Cloudflare's edge. A new `cloudflare_zero_trust_access_application`
covering wildcard `*.hookmyapp-listen.com` references the **existing**
forwarder service tokens (`forwarder-staging`, `forwarder-production`) —
no new tokens minted.

This matters: without `proxied=true` and the Access policy, CNAMEs flatten
directly to `<tunnelId>.cfargotunnel.com` and the tunnel becomes hittable
by any caller on the public internet (per Phase 107 RESEARCH §Pitfall 3).
Branded CNAMEs aren't cosmetic — they're the only way to enforce CF Access
on the tunnel.

**Forwarder injection is a refactor, not an extension.** Today the
forwarder gates CF Access header injection on the `isSandbox` boolean
parameter passed to `forwardWebhook` (see `forwarder/src/webhook/webhook.service.ts:326`
and `:615-656`, with an explicit anti-leak comment "CRITICAL: isSandbox=false
on production path — CF-Access headers MUST NOT leak to customer webhooks").
The production call site always passes `isSandbox=false`, so even if a
production channel's `webhookUrl` were a tunnel host, headers wouldn't be
attached and the CF Access policy on `hookmyapp-listen.com` would reject
the request.

The fix: replace the `isSandbox` gate inside `forwardWebhook` with a
**destination-allowlist** check that recognizes hostnames under either
tunnel zone (`hookmyapp-sandbox.com` or `hookmyapp-listen.com`) and
attaches headers if the URL is in the allowlist, regardless of which call
site invoked it. The anti-leak invariant is preserved by the allowlist
itself — customer URLs that don't end in either zone never get headers.
The `isSandbox` flag can stay as an orthogonal signal for analytics tags
and the existing routing-decision logs, but it no longer controls CF
Access behavior.

### D6. Cost shape is "free at any scale we'd realistically hit."

- **Cloudflare:** $0/mo. CF Tunnels are unlimited on Zero Trust Free.
  Bandwidth through CF is free. DNS records on a dedicated zone are
  unconstrained at our scale.
- **GCP marginal cost per 24/7 user:** ~$0.33/mo dominated by the
  `/tunnel/heartbeat` Cloud Run endpoint at the current 30s heartbeat
  cadence. Tunable to ~$0.08/mo by widening to 120s. Inbound webhook
  delivery itself is rounding error.
- **At 1,000 always-on agentic users:** ~$300/mo GCP, $0 CF. At 10,000:
  ~$3,300/mo GCP.

The conclusion: 24/7 use is fine. No pricing/gating mechanism needed at
this point.

### D7. Schema migration only — no backfill, no behavior change.

A Prisma migration is required to: make `WebhookConfig.webhookUrl`
nullable, and add the new tunnel-state columns (all defaulting to null).
**No row backfill** — Model A (D2) means existing channels without a
`WebhookConfig` row keep that state. **No behavior change** for any
existing customer until they actively run `hookmyapp channels listen` or
touch the dashboard. Frontend health logic is updated separately (D9)
to interpret `webhookUrl=null` correctly, but no DB rows are rewritten.

### D8. Stale-tunnel reaper reuses the sandbox 72h threshold; UI uses a separate "offline" threshold.

The ops-worker `SandboxReconcileJob` today sweeps `SandboxSession` rows
whose `lastHeartbeatAt` is more than **72h** stale and tears down the CF
tunnel + DNS CNAME (`ops-worker/src/jobs/sandbox-reconcile.job.ts:29`,
`STALE_THRESHOLD_MS = 72h`). The 5-minute number in an earlier draft of
this spec was wrong and would have been incompatible with the stated 24/7
laptop/NUC use case (any temporary outage longer than 5min would
permanently lose the tunnel).

This feature reuses the same 72h threshold for `WebhookConfig` rows with
non-null tunnel fields and stale heartbeats. Tear-down clears the tunnel
fields (returning the channel to its default no-active-listener state) and
sends a one-shot email to the workspace owner.

The **UI's "offline" indicator** uses a much shorter threshold —
`lastHeartbeatAt > 90s` triggers a grey pulse with "CLI offline". This is a
display-only state; the CF resource is not touched, the row is not
modified. A user whose laptop sleeps overnight returns to a "CLI offline"
indicator and resumes immediately on next heartbeat — no re-provisioning
needed. Only after 72h of continuous absence does the reaper actually
delete the CF resources.

### D9. Frontend health computation becomes tri-state.

Today `frontend/src/lib/health.ts:37` returns "Webhook not configured" for
any channel where `!channel.webhookUrl`. With HookMyAppCLI as a valid
default destination, `null` webhookUrl is no longer inherently a
misconfiguration. New health states:

- **URL configured + recent success:** "Healthy" (current behavior).
- **URL configured + recent failure:** "Failing — last delivery
  &lt;status&gt;" (current behavior).
- **No URL + active CLI (heartbeat &lt; 90s):** "Healthy (HookMyAppCLI)".
- **No URL + stale CLI (heartbeat &gt; 90s, &lt; 72h):** "CLI offline —
  run `hookmyapp channels listen` to resume".
- **No URL + no tunnel (or tunnel reaped):** "No active destination — run
  `hookmyapp channels listen` to start, or configure a webhook URL".

The frontend reads `lastHeartbeatAt` + `hostname` (which are non-null only
when a tunnel exists) to derive these states. The "Webhook not configured"
red copy is replaced with the appropriate state-specific copy above.
Dashboard alerts (the email-alerting path that reports
`webhookConfig?.webhookUrl ?? 'unknown'`) only fires for the
URL-configured-and-failing case; the no-URL states are not "failure"
states and do not page.

### D10. CLI command name: `hookmyapp channels listen` (plural).

The CLI already ships a plural `channels` parent command at
`/Users/ordvir/COD/cli/src/commands/channels.ts` (the `channels`
namespace today covers list/show/manage operations against onboarded
channels). The new listen subcommand mounts under that existing plural
parent — `hookmyapp channels listen` — rather than introducing a
parallel singular `hookmyapp channel` command.

**Rejected alternative:** singular `hookmyapp channel listen`. Mounting
on a brand-new singular parent would:
- Surface a confusing UX inconsistency in `--help` (singular alongside
  plural with overlapping semantics).
- Risk Commander parse-precedence ambiguity (which one wins on a typo?).
- Make discovery worse — a user typing `hookmyapp channels` to see all
  channel-related subcommands wouldn't see `listen`.

The dashboard's "Listen via CLI" modal and the tri-state health copy
in D9 both render the plural form (`hookmyapp channels listen --channel
<publicId>`) so the dashboard never instructs the user to type a
command that doesn't exist.

## Open questions

None. All blocking decisions are locked.

## Revision history

- **2026-05-15** — Initial draft.
- **2026-05-15 (rev 2)** — Code review surfaced six issues, all valid:
  D2 expanded to explicitly choose Model A (lazy WebhookConfig row) and
  describe its lifecycle vs Model B; D3 expanded to define the heartbeat
  410 / `CHANNEL_TUNNEL_RECLAIMED` contract; D5 expanded to clarify the
  forwarder refactor (destination-allowlist replaces `isSandbox` gate for
  CF Access injection); D7 reworded from "no data migration" to "schema
  migration only — no backfill, no behavior change"; D8 corrected
  reaper threshold from 5min to 72h (sandbox parity) and split UI
  "offline" indicator (90s) from reaper teardown (72h); new D9 defines
  tri-state frontend health computation.
- **2026-05-15 (rev 3)** — Two wording fixes from follow-up review: D1
  paragraph no longer says forwarder "forwards to whatever URL is
  configured" (stale under Model A); now describes URL-or-active-tunnel
  resolution. Implementation-surface bullet for the forwarder reframed
  from "`isTunnelHost` extension" to the full destination-allowlist
  refactor + production routing-precedence change, so the plan does not
  scope it too narrowly.
- **2026-05-15 (rev 4)** — Implementation-surface section expanded to
  fully enumerate code + tests + operational surfaces so the plan covers
  all of them. CLI surface is now broken out (commands directory, api
  client additions, wizard menu, heartbeat 410 handling, PostHog
  observability) rather than a single line. Test surface now explicitly
  enumerates backend integration, forwarder integration, ops-worker
  reaper, CLI integration, and frontend page tests per the CLAUDE.md
  hard rules.
- **2026-05-15 (rev 7)** — Aligned the CLI command name with the
  decision encoded in both plans. The spec previously read
  `hookmyapp channel listen` (singular) in goals, D7 / D9 references,
  Scope header, and the Listen-via-CLI affordance description.
  Replaced with `hookmyapp channels listen` (plural) everywhere. Added
  D10 documenting the choice — plural mounts on the existing
  `channels` parent in `cli/src/commands/channels.ts`, avoiding the
  singular/plural UX collision a parallel `channel` command would
  cause. Dashboard copy + tests in the plans render the same plural
  form.
- **2026-05-15 (rev 5)** — Made the two-repository scope explicit in the
  Scope header and implementation-surface section. Every bullet now
  carries a `[monorepo]` or `[cli]` tag so the plan-author cannot
  collapse the work into a single PR by accident. Coordinated release
  sequencing (monorepo deploy then CLI minor cut) added to the
  Operational section. CLI version-pinning via the existing
  `cli-and-skill-version-enforcement` mechanism noted as part of the
  CLI surface.
- **2026-05-15 (rev 6)** — Two fixes from follow-up review: (a) CLI
  version-pinning wording was backwards (older CLIs don't have
  `channel listen` at all — the guard is for the NEW CLI installed
  before the monorepo deploy lands); reworded accordingly. (b) New
  backend bullet added for the channel read-API surface (list + detail
  DTOs must expose `webhookUrl`, `hostname`, `lastHeartbeatAt`, and
  optionally a derived `hasActiveCliTunnel` boolean); tunnel token + ID
  remain server-only. A matching backend read-API contract-test bullet
  added.

## Implementation surface (deferred to plan)

The plan will lay out the following surfaces. The spec does not enumerate
file paths or fixture content — the plan does — but the surfaces below
must all be covered or explicitly decomposed into a follow-up phase.

**Repo boundary (important for the plan handoff).** The work spans
**two separate repositories**, each with its own PR/release flow:

- **`/Users/ordvir/COD/hookmyapp`** (this repo, `hookmyapp/hookmyapp`)
  — backend (`backend/`), forwarder (`forwarder/`), frontend
  (`frontend/`), ops-worker (`ops-worker/`), Terraform (`terraform/`),
  shared Prisma schema (`packages/db/`). The spec itself is committed
  here.
- **`/Users/ordvir/COD/cli`** (`hookmyapp/cli`, published as
  `@gethookmyapp/cli` on npm) — the new `hookmyapp channels listen`
  command, API-client additions, wizard branch, heartbeat-410 lifecycle
  handling, PostHog observability events, and CLI integration tests
  (using the `HOOKMYAPP_E2E_FAKE_TUNNEL` escape hatch).

The plan must coordinate the release ordering. The CLI cannot call the
new channel-tunnel endpoints until the backend has shipped them, so the
ordering is: backend + forwarder + Terraform first (with the new
endpoints live and the listen zone provisioned), CLI release second
(with a minimum required-backend version pinned in the CLI's runtime
version-check, see existing `cli-and-skill-version-enforcement` spec).
Frontend changes can land in parallel with backend since they only show
the new UI states after the backend is live.

### Code

Each bullet is tagged with its repo: **[monorepo]** =
`/Users/ordvir/COD/hookmyapp`, **[cli]** = `/Users/ordvir/COD/cli`.

- **[monorepo] Prisma schema** changes to `WebhookConfig` and migration
  SQL (make `webhookUrl` nullable; add `cloudflareTunnelId`,
  `cloudflareTunnelToken`, `hostname`, `lastHeartbeatAt`; verify
  `verifyToken` stays required and is auto-generated when the row is
  lazy-created by `tunnel/start`).
- **[monorepo] Backend module** for `/api/channels/:id/tunnel/{start,
  configure,heartbeat,stop}` (lift of the sandbox tunnel controller; the
  underlying `CloudflareTunnelService` is parameterized to take a
  zone-name input rather than reading a hardcoded env var; `heartbeat`
  returns the `410 CHANNEL_TUNNEL_RECLAIMED` AppError per D3 when the
  row's tunnel fields have been cleared; `start` enforces the "no active
  tunnel for a different CLI instance" conflict per the sandbox
  enforcement matrix).
- **[monorepo] Channel read-API surface:** the existing channel list +
  channel detail responses consumed by the frontend and the CLI's
  channel picker must be extended to expose the destination state.
  Specifically, the response DTO needs `webhookConfig.webhookUrl` (today
  this exists but it's non-null; becomes nullable), `webhookConfig.hostname`
  (the active CF tunnel hostname when a CLI is listening, else null),
  and `webhookConfig.lastHeartbeatAt` (when the active tunnel last
  heartbeated, else null). Tunnel token + tunnel ID are NEVER exposed
  on the read API — only the server uses those. Optionally the backend
  can compute and expose a derived `hasActiveCliTunnel` boolean
  (`hostname != null && lastHeartbeatAt > now - 90s`) so the frontend
  doesn't duplicate the freshness math from D9; the plan picks one
  approach.
- **[monorepo] Forwarder refactor:** replace the `isSandbox`-gated CF
  Access header injection in `forwardWebhook` with a
  destination-allowlist check that recognizes hostnames under either
  tunnel zone (`hookmyapp-sandbox.com` or `hookmyapp-listen.com`). See
  D5 — this is a structural change, not a one-line extension. Also:
  extend the production routing path so it consults
  `webhookConfig.cloudflareTunnelId` + `hostname` + `lastHeartbeatAt`
  when `webhookUrl` is null, per the precedence in D2.
- **[monorepo] Ops-worker reaper extension:** `SandboxReconcileJob` (or
  a sibling job in the same file) extended to also sweep `WebhookConfig`
  rows with stale (>72h) tunnel fields. Same teardown mechanics — CF
  tunnel + DNS CNAME delete, null out the row's tunnel fields. Plus
  one-shot workspace-owner email.
- **[cli] CLI** — new surface area is meaningful, not just one command:
  - `src/commands/channel/listen/` directory mirroring
    `src/commands/sandbox-listen/` (`index.ts`, new `picker.ts`,
    `proxy-server.ts` reused via import, `lifecycle.ts` reused via
    import). The new `picker.ts` lists workspace channels with
    `forwardingEnabled=true`.
  - `src/api/client.ts` additions for the four channel-tunnel endpoints.
  - Top-level wizard menu addition in `src/auth/login.ts` (or wherever
    the no-arg flow lives today) — gains a "Listen on a real channel"
    branch alongside the existing sandbox flow.
  - `src/commands/sandbox-listen/lifecycle.ts` heartbeat loop generalized
    (or paralleled in a new `channel/listen/lifecycle.ts`) to handle the
    new `410 CHANNEL_TUNNEL_RECLAIMED` terminal status — exit 0 with the
    user-facing copy from the AppError's `userMessage`.
  - Observability: PostHog `channel_listen_*` events parallel to the
    existing `sandbox_listen_*` events.
  - Version-pinning: the new CLI minor declares a minimum-required
    backend version via the existing `cli-and-skill-version-enforcement`
    mechanism, so the new CLI does not call channel-tunnel endpoints on
    a backend that hasn't shipped them yet. (Older CLIs are not the
    concern — they don't have `channels listen` at all. The concern is a
    user installing the new CLI minor before the monorepo deploy lands.)
- **[monorepo] Frontend** (`frontend/`):
  - Channel-detail page renders the "HookMyAppCLI" default pill when
    `webhookConfig?.webhookUrl == null`, the URL when set, plus
    live-heartbeat indicator state per D9.
  - "Listen via CLI" affordance — a copy-button modal exposing the
    exact `hookmyapp channels listen --channel <publicId>` invocation.
  - `frontend/src/lib/health.ts` rewritten to the tri-state computation
    in D9 (no longer red on `!webhookUrl`).
  - Email-alert dashboard copy (today reports `webhookConfig?.webhookUrl
    ?? 'unknown'`) updated so the no-URL states are not classified as
    alertable failures.
- **[monorepo] Terraform:** new CF zone for `hookmyapp-listen.com`, new
  `cloudflare_zero_trust_access_application` for `*.hookmyapp-listen.com`
  (reusing the existing forwarder service tokens in its policy `include`
  list — no new tokens minted), new env-var wiring on backend + forwarder
  Cloud Run services for the listen zone name/ID.

### Tests

Per CLAUDE.md hard rules, every phase must include backend integration
tests + frontend page tests, not just unit-with-mocks. Required coverage:

- **[monorepo] Backend integration tests** for the four channel-tunnel
  endpoints (`start`, `configure`, `heartbeat`, `stop`), including:
  - Happy-path tunnel provisioning + idempotent re-start.
  - Conflict matrix (channel not found, forwarding disabled, channel
    deleted, listener-active-same).
  - `heartbeat` returns `410 CHANNEL_TUNNEL_RECLAIMED` when tunnel
    fields are nulled mid-flight (covers D3 contract).
  - Setting `webhookUrl` via the channels endpoint tears down the active
    tunnel (covers D3 happy path).
- **[monorepo] Backend read-API contract tests** for the extended
  channel list + channel detail DTOs: shape includes `hostname` and
  `lastHeartbeatAt` (and `hasActiveCliTunnel` if the backend computes
  it); tunnel token and tunnel ID are NEVER serialized into the response;
  fields are correctly null for channels with no active tunnel.
- **[monorepo] Forwarder integration tests:**
  - CF Access headers ARE attached when the destination URL host ends
    with `hookmyapp-listen.com` (the new allowlist behavior).
  - CF Access headers are NOT attached for customer URLs (anti-leak
    invariant preserved post-refactor).
  - Production routing path forwards through a tunnel when
    `webhookUrl=null` and tunnel fields are populated.
  - Production routing path returns `no_webhook_config` when no URL and
    no active tunnel (existing behavior preserved).
- **[monorepo] Ops-worker reaper test:** extends
  `sandbox-reconcile.job.spec.ts` pattern to assert channel-tunnel rows
  older than 72h are reaped, fresh ones are not, and CF resources are
  deleted.
- **[cli] CLI integration tests** (`test-integration/`): `channel
  listen` flow against the local backend's `HOOKMYAPP_E2E_FAKE_TUNNEL`
  escape hatch (same pattern as the existing sandbox-listen integration
  test) — covers picker, tunnel start, proxy server bind, heartbeat,
  graceful shutdown, and the new `410 CHANNEL_TUNNEL_RECLAIMED` exit
  path.
- **[monorepo] Frontend page tests** following the canonical pattern in
  `frontend/src/pages/{Page}/test/{Page}.page.test.ts` (Playwright +
  `page.route` for HTTP mocking, ARIA-role locators, anatomy limits per
  CLAUDE.md `Frontend Page Tests` hard rule):
  - Channel-detail page: HookMyAppCLI default pill renders for
    `webhookUrl=null`; URL renders when set; tri-state health states
    per D9 (active CLI / offline CLI / no tunnel) each render the
    correct copy and color.
  - Channels list page: destination column shows the right rendering
    per row state.
  - Health-logic tests for `frontend/src/lib/health.ts` (vitest, pure
    function — companion to the page tests, not a replacement).

### Operational

- **[monorepo]** Domain registration follow-through: point
  `hookmyapp-listen.com` nameservers at Cloudflare, confirm zone
  activation, apply Terraform.
- **[cli]** Coordinated release: cut a new CLI minor (e.g. `0.12.0`)
  containing the channel-listen surface AFTER the monorepo backend +
  forwarder + Terraform deploy lands on staging-then-prod. Publish to
  npm with sigstore provenance per the existing CLI release flow.
