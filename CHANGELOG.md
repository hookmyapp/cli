# Changelog

All notable changes to `@gethookmyapp/cli` are documented here.

## 0.12.3 — 2026-05-26

### Added

- `hookmyapp sandbox logs --phone|--username|--session [--follow] [--json] [--limit <n>]` — verbose dump of webhook deliveries for a sandbox session. Every delivery prints with its inbound body and forward attempt(s) inline (debugging is the only use case for this command, so verbose is the default — no flag exploration needed). Mirrors the GUI Deliveries panel's expanded-row content. `--follow` streams new deliveries via SSE in the same format. `--json` emits one delivery DTO per line for jq pipelines. Primary use case: AI coding agents (Claude Code, Codex) that need to verify the webhook round-trip — did HookMyApp deliver, and what did the user's own server reply with.
- `hookmyapp sandbox start --type=instagram` — bind an Instagram sandbox session by DMing the env-configured sandbox IG handle (`@hookmyappsandboxstaging` on local + staging; production gated until the prod handle is provisioned).
- `--username <@handle>` selector flag on `sandbox env`, `sandbox send`, `sandbox stop`, `sandbox webhook show/set/clear`, and `sandbox listen` — selects an Instagram session by handle. Falls back to IGSID match when the username is still being backfilled by the backend.
- `--session <ssn_XXXXXXXX>` promoted to a universal selector across the same five subcommand groups (was sandbox-listen-only).
- `INSTAGRAM_API_URL`, `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID` env vars emitted by `sandbox env` when the selected session is Instagram.
- Boundary parser that validates every `GET /sandbox/sessions*` response into a `WhatsAppSandboxSession | InstagramSandboxSession` discriminated union. Malformed wire data surfaces as `UnexpectedError` (`MALFORMED_SANDBOX_SESSION`, exit 1).
- `hookmyapp sandbox start <whatsapp|instagram>` positional shortcut — alternative to `--type=<channel>` (both still supported; conflict errors if positional and flag disagree).
- **Phase A (D3 + D9):** Positional shape-detected `[identifier]` argument on `sandbox stop`, `sandbox env`, `sandbox send`, `sandbox logs`, `sandbox listen`, and `sandbox webhook show/set/clear` — `hookmyapp sandbox send +972545434384 --message "hi"` instead of `--phone +972545434384`. Accepts `+<phone>`, `@<username>`, or `ssn_XXXXXXXX`. Existing `--phone` / `--username` / `--session` flags remain as a typed-fallback path; positional and flag conflict errors if both are provided and disagree.
- **Phase A (D9):** `sandbox logs --verbose` (`-v`) flag — full inbound body + forward attempt dump (the previous default).
- **Phase A:** `parseIdentifier()` shared helper at `src/lib/parseIdentifier.ts` for shape detection across sandbox (and future channels) commands.
- **Phase B (D6):** `hookmyapp channels connect [type]` — `whatsapp` opens Meta Embedded Signup; `instagram` opens the IG OAuth URL. Bare invocation prompts in TTY; non-TTY exits 2.
- **Phase B (D2):** Coexistence post-connect polling — when one OAuth flow returns both a WhatsApp and Instagram channel, both are reported.
- **Phase B (D8):** `channels logs list --follow` — SSE live tail of webhook deliveries.
- **Phase B (D9):** `channels logs list --json` — JSONL output (one delivery DTO per line).
- **Phase B (D9):** `channels logs list --verbose` — full detailed dump (default switched to one-line summary).
- **Phase B:** Every `channels` subcommand (`list`, `show`, `disconnect`, `enable`, `disable`, `env`, `token`, `health`, `webhook show/set`, `listen`, `logs`) now accepts Instagram channels — same flag surface, same exit codes, same JSON shape per type.

### Changed

- `sandbox status` table now renders `Type | Identifier | Status | Listener` columns instead of `Phone | Status | Listener`. Identifier is `+<phone>` for WhatsApp and `@<handle>` for Instagram (falls back to IGSID).
- **Phase A (D9):** `sandbox logs` default render flipped to **table-by-default** — one-line summary per delivery (timestamp · sender · target · status · latency · preview). Use `--verbose` for the previous full-dump format. Rationale: scanning recent deliveries is the common case; full-body dumps are the debugging-only case.
- **Phase A (D3):** The previously-deprecated `[phone]` positional on `sandbox webhook show/set/clear` is repurposed to a first-class `[identifier]` positional (accepts `+phone`, `@username`, `ssn_XXXXXXXX`). The earlier stderr deprecation warning is removed — positional is now the recommended shape across the sandbox surface, so the `### Deprecated` section is no longer carried in this release.
- **Phase B:** `ApiChannel` interface replaced with boundary-parsed `Channel` discriminated union (`parseChannelListItem` + `parseChannelDetail` at `src/api/channel.ts`). Tolerates unknown wire extras.
- **Phase B:** `channels list` table renders `@username` for Instagram rows and `+phone` for WhatsApp rows.
- **Phase B (D6):** `login --next channels` becomes channel-type-aware — prompts for type in TTY; exits 2 in non-TTY.
- **Phase B (D9):** **Wire contract change** — `channels logs list --json` now emits JSONL (one detail DTO per line) instead of the raw page envelope. Any automation that parsed the previous page payload must switch to line-delimited JSON parsing.

### Fixed

- **Phase B (D2):** `channels connect` no longer hangs the full 5-minute `CONNECT_TIMEOUT` when re-authing an existing channel. The post-OAuth poll now snapshots `{channelId -> updatedAt}` before opening the browser and treats either a new channel id OR an existing id whose `updatedAt` advanced past the snapshot as "interesting." Token rotation against an existing WABA/IG handle (the common case when the operator picks the same business again) is detected and reported within the 4-second stability window. Requires the paired backend addition of `updatedAt` to the `/meta/channels` list DTO; older backends fall back to id-diff-only behavior.

## 0.12.1 — 2026-05-17

### Breaking

- Channel identifier syntax changed from Meta WABA ID to HookMyApp Channel ID (`ch_xxxxxxxx`). Run `hookmyapp channels list` to see your channel IDs. All `<waba-id>` positional args now take `<channel>`. The CLI also accepts `phoneNumberId`, display phone numbers, and display names. Passing an old wabaId returns a helpful error pointing at `channels list`.
- `hookmyapp channels listen --channel <id>` → positional `hookmyapp channels listen [channel]`. Omit the arg to get the interactive picker.

### Added

- **Canonical command surface nested under `channels`:** all channel-scoped commands now live under `hookmyapp channels` — `channels env`, `channels token`, `channels health`, `channels webhook show`, `channels webhook set`. Top-level forms (`hookmyapp env`, `hookmyapp token`, `hookmyapp health`, `hookmyapp webhook`) continue to work as deprecated aliases for ONE release; they emit a stderr warning and delegate to the canonical handler. They'll be removed in a future release.
- `channels list` table now shows "Channel ID" and "type" columns. `metaWabaId` remains in `--json` output for back-compat.
- `hookmyapp channels env <channel> --write .env` writes `HOOKMYAPP_CHANNEL_ID=ch_xxx` alongside existing `WHATSAPP_WABA_ID=` (additive).

### Fixed

- `--workspace` flag now properly injects `X-Workspace-Id` on every authenticated endpoint, including `env`. Previously, only some subcommands honored it.

### Deprecated

- `hookmyapp env`, `hookmyapp token`, `hookmyapp health`, `hookmyapp webhook show`, `hookmyapp webhook set` — use the canonical nested form (`hookmyapp channels env`, etc.).

## [0.12.0] - 2026-05-16

### Added

- **`hookmyapp channels listen`** — listen for inbound WhatsApp webhooks
  on a real onboarded channel via a per-channel Cloudflare Tunnel. Same
  mechanics as `sandbox listen`, but for production WABAs (no customer
  HTTPS URL required). Tunnels can stay up indefinitely — 24/7 use is
  supported and expected (e.g. OpenClaude-style local agents).

  ```bash
  hookmyapp channels listen --channel ch_XXXXXXXX --port 3000
  ```

  When the CLI is running, the channel's dashboard destination shows as
  **HookMyAppCLI**. Stop with Ctrl-C — the destination returns to its
  default (HookMyAppCLI awaiting a CLI, or your previously-configured
  webhook URL if one was set).

  If you set a webhook URL in the dashboard while the CLI is mid-listen,
  the CLI exits cleanly with a notice on its next heartbeat — the URL
  wins (spec D3, surfaced as `410 CHANNEL_TUNNEL_RECLAIMED`).

- **Wizard branch after `hookmyapp login`.** When the active workspace has
  ≥1 forwarding-enabled channel, the post-login flow offers a three-way
  select: real-channel listen, sandbox, or print the next-steps guide.
  Default selection is real-channel. First-run / sandbox-only users
  keep today's printed-guide behavior.

- **PostHog events:** `cli_channel_listen_started`,
  `cli_channel_listen_liveness` (2h backstop), `cli_channel_listen_stopped`
  — parallels the existing `cli_sandbox_listen_*` event shape.

## [0.11.1] - 2026-05-10

### Fixed

- **Sentry no longer reports user typos as production errors.** Commander
  argv-parse failures (`missingArgument`, `invalidArgument`, `unknownOption`,
  `unknownCommand`, etc.) now route to PostHog as `cli_parse_error` events
  instead of Sentry exceptions. Previously, `hookmyapp config get` (no key)
  would page on-call as a "production CommanderError"; now it lands in
  PostHog's funnel where you can answer "which subcommand pair gets mistyped
  most" without polluting the engineering-error project.

  Tomer-class `ConfigWriteForbiddenError` (EPERM on config write) and every
  other `AppError` subclass remain captured by Sentry. The filter targets
  ONLY error codes prefixed `commander.`. Regression test pinned.

## [0.11.0] - 2026-05-09

### Breaking Changes

- **Config directory moved to `~/.config/hookmyapp/`** (XDG Base Directory
  Spec). Existing `~/.hookmyapp/` installations are migrated transparently
  on the first invocation of any `hookmyapp` command. No re-login required.
  `HOOKMYAPP_CONFIG_DIR` continues to override.
### Added

- **Actionable error message on `EPERM`/`EACCES`/`EROFS`** writing the
  config file (the failure mode hit by users running the CLI inside
  sandboxed shells like Claude Code). Surfaces the two recovery paths:
  real terminal, or `HOOKMYAPP_CONFIG_DIR=$PWD/.hookmyapp`.
- **Sentry offline transport.** Errors thrown while offline persist to
  `<config-dir>/sentry-offline/` and replay automatically on the next
  invocation that successfully reaches `ingest.sentry.io`.

### Fixed

- **Silent-Sentry bug #1** that disabled crash reporting for the rest of the
  process whenever the disclosure-banner write hit `EPERM`/`EACCES`
  (sandboxed shells, read-only filesystems). The disclosure call is now
  isolated in its own try/catch outside the init success path.
- **Silent-Sentry bug #2: `shouldCaptureToSentry` filter excluded local CLI
  errors.** The previous heuristic skipped any error with a non-undefined
  `statusCode`, intended to avoid double-capturing backend-wrapped 5xx
  errors. But the `AppError` base class derives `statusCode` from each
  subclass's static `httpStatus` getter — so locally-thrown
  `ValidationError`/`AuthError`/`PermissionError`/`ConflictError`/
  `RateLimitError`/`UserBlockingError`/`ConfigurationError` ALL carried a
  `statusCode` and were silently filtered out. Only `NetworkError` and
  errors with no `httpStatus` ever reached Sentry. Filter removed in
  0.11.0; CLI-side perspective is preserved on every error and Sentry's
  fingerprint grouping handles backend-overlap dedup. Combined with
  bug #1, this is why the `hookmyapp-cli` Sentry project had zero events
  for 30 days; expect normal volume once 0.11.0 rolls out.

### Why

- Aligns with modern CLI conventions (`gh`, `gcloud`, `stripe`, `vercel`).

## [0.10.3] - 2026-05-09

### Added

- **Version-enforcement headers.** Every backend request now carries
  `User-Agent: hookmyapp-cli/<v> (node/<v>; <arch>; <os>)`,
  `X-HookMyApp-CLI-Version`, `X-HookMyApp-Lang`, `X-HookMyApp-Runtime-Version`,
  `X-HookMyApp-Arch`, `X-HookMyApp-OS`, and (when the marker file is present)
  `X-HookMyApp-Skill-Version`. Mirrors the Stainless `x-stainless-*` headers
  used by the OpenAI and Anthropic SDKs. Server uses these to gate
  compatibility (soft-warn at `min_recommended`, hard 426 at `min_required`).
- **Skill marker reader at `~/.config/hookmyapp/skill-version`.** Three states:
  absent → header omitted; parseable semver → header carries value; corrupt /
  empty / non-semver / unreadable → `invalid` sentinel (server treats as
  definitively outdated). Distinguishing "absent" from "corrupt" closes the
  bypass where a damaged marker file would silently disable the skill-version
  gate.
- **Soft-warn banner** when the response carries `X-HookMyApp-Client-Outdated`.
  Suppressed by `NO_UPDATE_NOTIFIER=1` (npm/AWS CDK/Vue CLI/Yeoman convention).
- **426 Upgrade Required handler.** Server-returned `messages[]` are printed
  verbatim and the CLI exits 1. No per-command code path — handled in the
  shared HTTP client, applies to every command family (auth, workspace,
  channels, sandbox, env, token, webhook, health, billing).

### Why

- Backend interceptor (Phase 1) shipped 2026-05-06 but had no client to honour
  the header contract — it was failing-open on every request. This release
  closes the loop.
- Pre-emptive groundwork for any future breaking change to the CLI's API
  contract: bump `min_recommended` on release, bump `min_required` 2-4 weeks
  later after watching usage logs drop. Industry-standard staged rollout
  (Stripe, AWS, Heroku, gcloud all converge on this shape).

## [0.10.2] - 2026-05-06

### Breaking Changes

- **OAuth flow rewrite.** `hookmyapp channels connect` now mints OAuth state
  via the backend's new `POST /meta/oauth/start` endpoint instead of
  embedding the CLI's JWT in the OAuth `state` URL parameter. Older CLI
  versions (`<= 0.10.1`) will be rejected by the dashboard's `/cli/callback`
  page with an "Upgrade required" message.
- **`hookmyapp env <waba-id>` now prefixes output keys with `WHATSAPP_`.**
  The dotenv block written/printed by `env` and `sandbox env` uses
  `WHATSAPP_WABA_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_API_URL` instead of the unprefixed names. Update any `.env`
  files and code that read the old names. `VERIFY_TOKEN` is unchanged
  (sandbox-session HMAC concept, not a WhatsApp-API value).
- **`env <waba-id> --write [path]` upserts in place.** The new flag merges
  the prefixed block into an existing `.env` (or creates one) instead of
  printing to stdout. Existing `WHATSAPP_*` keys are replaced; unrelated
  keys are preserved.

### Why

- RFC 6750 §5.3 forbids transmitting bearer tokens in URL query parameters.
  The previous design leaked the CLI's JWT to browser history and Meta's
  redirect-handler logs.
- Adds PKCE (RFC 7636) so the OAuth code-for-token exchange is bound to a
  server-stored verifier.
- Server-side state replaces fragile `localStorage`/`sessionStorage` nonce
  storage that broke in popup mode.

### Upgrade

```bash
npm install -g @gethookmyapp/cli@latest
```

If you don't upgrade, `hookmyapp channels connect` will redirect to a
"please upgrade" page instead of completing the flow.

## [0.10.0] - 2026-05-02

### Changed

- **Graph API version is now server-delivered.** `sandbox env` and `sandbox send` previously hardcoded `/v22.0/` into the proxy URL, which meant every Meta Graph API bump required a coordinated CLI release. The session response now carries `whatsappApiVersion` (sourced from the backend's `META_GRAPH_VERSION` env), and the CLI composes the proxy URL using that value. A future Graph version bump is a backend-only change. Required against backend ≥ today's `chore(meta): server-deliver whatsappApiVersion` commit.
- **Default Graph API version is `v24.0`** (up from v22.0) to match the version the backend now serves and the sandbox-proxy now accepts.

## [0.9.5] - 2026-04-26

### Fixed

- **`sandbox listen` now actually blocks until shutdown.** Previously
  `runSandboxListenFlow` registered SIGINT/SIGTERM handlers and returned;
  the top-level `await flushAndExit(0)` in src/index.ts then ran
  immediately. The command stayed alive in interactive terminals only
  because cloudflared's stdio happened to keep the event loop pumping. In
  non-TTY contexts (`nohup`, `setsid`, `< /dev/null`, `docker --no-tty`,
  systemd / Cloud Run / Fly.io) the listener exited within seconds. The
  fix is a single shutdown Promise resolved by exactly three events:
  SIGINT (exit 0), SIGTERM (exit 0 — same graceful path; required for
  Cloud Run / Docker stop / k8s clean shutdown), or cloudflared child
  exiting unexpectedly (exit 7 — new code, after running the same
  cleanup the signal path runs). Help text gains an EXAMPLES line for
  background invocation: `nohup hookmyapp sandbox listen --port 3000 &`.
  Regression test lives at
  `test-integration/specs/sandbox-listen.spec.ts` and currently
  describe-skips behind `SANDBOX_LISTEN_INTEGRATION=1` due to upstream
  test-infra rot (see file header for the four pre-existing blockers); it
  will activate as a CI gate once those are unblocked.

### Added

- New exit code `7` — cloudflared child process exited unexpectedly
  while `sandbox listen` was running. Codes 0..6 retain their existing
  meanings (CONTEXT.md §CLI Flow).

## [0.9.4] - 2026-04-26

### Added

- **CLI now identifies the PostHog person with email + name on login.**
  After the once-per-(machine, user) alias fires, `posthogAliasAndIdentify`
  also calls `client.identify({ distinctId: sub, properties: { email,
  name, $set: { email, name } } })` so the PostHog Persons UI shows the
  human identity for CLI events without requiring a separate frontend
  login. Mirrors the frontend's Phase 125 Plan 06 identify shape. Email
  comes from the WorkOS authenticate response; name only on the device
  flow (the bootstrap-code response carries email only).

## [0.9.3] - 2026-04-26

### Fixed

- **Drop `prepublishOnly` script that silently broke esbuild secret bakes.**
  Root cause of `Sentry` + `PostHog` bakes shipping as empty strings in
  every release since Phase 123: the `prepublishOnly: "node build.mjs"`
  script in `package.json` re-ran build.mjs DURING `npm publish`, but the
  workflow's Publish step has no `env:` block, so the rebuild used
  `process.env.HOOKMYAPP_*=undefined` and clobbered the properly-baked
  bundle from the explicit Build step. Removing the redundant
  `prepublishOnly` (the workflow's Build step already builds explicitly)
  preserves the baked DSN + token through publish.

## [0.9.2] - 2026-04-26

### Fixed

- (Did not work — version bump only; bake still empty due to the
  `prepublishOnly` clobber documented in 0.9.3.) Attempted to set real
  `HOOKMYAPP_POSTHOG_TOKEN` + `HOOKMYAPP_POSTHOG_HOST` GitHub Actions
  repo secrets after discovering 0.9.1 had empty bakes. Real fix is
  0.9.3.

## [0.9.1] - 2026-04-26

### Added

- **PostHog product analytics (Phase 125).** CLI emits `cli_first_run`,
  `cli_command_invoked`, `cli_logged_in`, plus `sandbox_listen_*`
  heartbeat events. `posthog-node` is loaded lazily and only fires when
  telemetry is on and `HOOKMYAPP_POSTHOG_TOKEN` was baked into the bundle
  at build time. `HOOKMYAPP_TELEMETRY=off` disables PostHog and Sentry
  together.
- **Publish workflow** now passes `HOOKMYAPP_POSTHOG_TOKEN` and
  `HOOKMYAPP_POSTHOG_HOST` from repo secrets to `node build.mjs`, so the
  published binary actually carries the bake values.

## [0.6.1] - 2026-04-18

### Changed

- **Per-env sandbox-proxy URL.** `env=staging` now routes to
  `https://staging-sandbox.hookmyapp.com` (dedicated Cloud Run service in
  the staging GCP project). `env=production` remains
  `https://sandbox.hookmyapp.com`. Previously both resolved to the prod
  URL via the shared-URL design — that defeated the point of having
  isolated per-env sandbox-proxy services.

### Backend dependency

- Requires Phase 120 infra (both `staging-sandbox.hookmyapp.com` and
  `sandbox.hookmyapp.com` Cloud Run services live). Deployed 2026-04-18.

## [0.6.0] - 2026-04-17

### Changed

- **Post-Phase-118 URL shape alignment.** The HookMyApp app URL structure
  flipped from `/dashboard/*` to workspace-scoped `/w/:ws/*` + user-scoped
  `/account/*`. CLI source itself had no `/dashboard` references (URL
  construction routes through the `appUrl` base + workspace-resolved
  suffixes only), so this is a metadata release signaling compatibility
  with the post-118 app. Consumers that read CLI output for URL strings
  should update expectations to match the `/w/:ws/*` shape the app now
  emits.

### Decisions

- No changes to the `hookmyapp login` "Next steps" block. The current
  block prints command-shaped entries (`sandbox start`, `channels
  connect`, `help`). Mixing a raw URL deep-link (`${appUrl}/w/${ws}`)
  into a command list would break the column-aligned `cmd — desc`
  visual contract. A URL-shaped deep-link helper belongs in a separate
  output surface (future `hookmyapp workspace url` or a `--print-url`
  flag on `workspace current`), not the next-steps guide. Tracked for a
  later minor release.

### Compatibility

- Backend contract unchanged. No migration needed.
- CLI still accepts prefixed publicIds on `--workspace` / `--session`
  flags (Phase 117 contract, unchanged).
- Requires backend Phase 117 or later (unchanged from 0.5.0). Phase 118
  is purely a frontend URL restructure — backend API surface untouched.

## [0.5.0] - 2026-04-17

### Breaking Changes

- All id flags (`--workspace`, `--session`) now require Stripe-style
  publicId format (e.g. `ws_A4zq8d2T`, `ch_a4Zq8d2T`, `ssn_3Bq8RkP2`).
  Raw UUIDs are rejected with a typed validation error (exit 2) before
  the CLI ever talks to the backend.
- `workspace use <name-or-id>` accepts a ws_ publicId, a workspace name,
  or a WorkOS organizationId slug. Raw UUID is rejected.
- `workspace invites cancel <id-or-email>` expects an `inv_` publicId
  (was raw UUID) or an email address.
- Stored config (`~/.hookmyapp/config.json`) field `activeWorkspaceId`
  now carries a `ws_` publicId. Any pre-0.5.0 config with a UUID value
  is silently dropped on read — the CLI falls through to the login
  wizard's workspace picker (or single-workspace auto-select) on the
  next command. The `env` slice of the file (managed by
  `hookmyapp config set env ...`) is preserved across the drop.
- Requires backend Phase 117 or later. Monorepo main contains the
  boundary-strict handlers that reject raw UUIDs; older backends that
  still accept UUIDs will appear to work but are out of contract.

### Migration

- Re-run `hookmyapp login` (or `hookmyapp workspace use <name>`) on
  upgrade to refresh the config file with the publicId shape.
- Any scripts / CI using `--workspace=<uuid>` or
  `hookmyapp sandbox listen --session=<uuid>` must be updated to
  `--workspace=ws_<8-char>` / `--session=ssn_<8-char>` using the
  publicId shown in `hookmyapp workspace list` /
  `hookmyapp sandbox status`.
- Meta OAuth redirect URL is unchanged (`${appUrl}/cli/callback`);
  the frontend cli-callback (Phase 117-03) now hands the publicId
  back to the CLI end-to-end.

### Internals

- New `src/lib/publicId.ts` — a verbatim copy of the 62-char
  Stripe-style alphabet + `isValidPublicId` regex from
  `@hookmyapp/shared`. `@hookmyapp/shared` is a monorepo-internal
  workspace package that is not published to npm, so the CLI uses
  this local fallback rather than a cross-repo dependency. Keep the
  alphabet / length / prefix list in sync manually on future changes.

## [0.4.0] - 2026-04-16

### Breaking Changes

- Renamed `accounts` command group to `channels` (6 subcommands: `list`,
  `show`, `connect`, `disconnect`, `enable`, `disable`). Rationale:
  product-wide rename from `Account` to `Channel` as the canonical noun
  for a WhatsApp connection (industry standard: Twilio, Intercom, Front,
  Zendesk). Leaves room for future non-WhatsApp channels. See HookMyApp
  Phase 116 in the monorepo.
- The `--next accounts` flag on `hookmyapp login` is now `--next channels`.
- `hookmyapp workspace current` now labels the count row as `Channels:`
  (was `Accounts:`) and reads the `channelCount` field from the API.
- Requires backend Phase 116 or later; the CLI talks to
  `/meta/channels/*` endpoints — old builds that still serve
  `/meta/accounts/*` will 404.

### Migration

Replace `hookmyapp accounts <subcommand>` with
`hookmyapp channels <subcommand>` in scripts or documentation. The
6 subcommands are identical in behavior; only the noun has changed.

There is no alias; `hookmyapp accounts list` now exits with
`unknown command 'accounts'` per the pre-production hard-rename policy.

## [0.3.0] - 2026-04-14

- CLI output primitives + global `--workspace` flag (see Phase 108-04).

## [0.2.0] and earlier

Historical releases; no changelog was tracked prior to this version.
