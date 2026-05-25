# Instagram support in the HookMyApp CLI sandbox commands

**Status:** draft (2026-05-25)
**Scope:** Single repository (`/Users/ordvir/COD/cli`, published as `@gethookmyapp/cli`). No backend changes — the multi-channel-instagram milestone has already shipped the wire contracts and sandbox-proxy IG send route on the monorepo side.
**Target release:** `@gethookmyapp/cli` 0.13.0 (single PR, full Instagram parity across all sandbox subcommands).

## Problem

The HookMyApp backend now mints sandbox sessions with `type: 'instagram'` (Phase 130 / multi-channel-instagram milestone). Dashboard users can already bind Instagram via the "Try Instagram" demo handoff; backend `BindCodeService.consume` accepts `senderType: 'instagram'`; sandbox-proxy serves `POST /v25.0/:igUserId/messages` with the IG body shape.

But the CLI is WhatsApp-only. Every sandbox subcommand (`env`, `send`, `start`, `status`, `stop`, `webhook show/set/clear`, `listen`) keys on phone, casts wire data without validation, and prints WhatsApp-flavored copy. A user who binds Instagram through the dashboard cannot reach those sessions from the CLI — the picker returns "(no phone)" because `phone` is null on IG rows, and the env-block emitter emits `WHATSAPP_*` vars that are useless for an IG starter kit.

The whole point of HookMyApp's sandbox is "go from zero to receiving real Meta webhooks on localhost in under five minutes". Today an Instagram developer hits that wall the moment they leave the dashboard.

## Goals

- An Instagram sandbox session is selectable, configurable, and operable from the CLI with the same UX shape as a WhatsApp session: pick it, get its env vars, send a test reply, set a webhook URL, tunnel webhooks to localhost.
- `hookmyapp sandbox start --type=instagram` produces a working bind-code QR + `ig.me` deep link, polls the bind, and reports the resolved session — symmetric to the WhatsApp flow.
- The Instagram CLI contract (env var names, flag names, error codes, exit codes) is decided once and locked. Starter kits that copy the emitted `.env` block keep working across CLI versions.
- Wire data from `GET /sandbox/sessions*` is **parsed** at the boundary into a discriminated union. The current `as SandboxSession[]` casts (at `sandbox.ts:96`, `sandbox.ts:145`, `auth/login.ts:383`, `sandbox-listen/index.ts:323`) are deleted. The CLI cannot ship the union as a fiction the compiler believes but the runtime doesn't honor.

## Non-goals

- **No new login command surface.** `hookmyapp login` keeps its current flags (`--code`, `--phone`, `--next sandbox`, `--next channels`, `--wizard`) unchanged. No `--username` is added. No `--session` pass-through is added. Login stays auth + workspace + next-step guidance. Provider logic lives under `sandbox`.
- **No removal of `login --phone`, `login --next sandbox`, `login --next channels`, or `login --wizard`.** All four are documented contracts or test plumbing.
- **No removal of the four deprecated top-level command families** (`hookmyapp env`, `hookmyapp token`, `hookmyapp health`, `hookmyapp webhook show/set` — five forms total). They were marked deprecated in 0.12.1 with a one-release runway; we explicitly choose to keep them through 0.13.0 and remove no earlier than 0.14.0 to keep the agent-paste path safe for one more cycle.
- **No `channels resolveChannel()` multi-channel support.** Today `resolveChannel` matches by `phoneNumberId`, `displayPhoneNumber`, or `wabaName` — all WhatsApp-biased. Instagram channels are reachable by `ch_xxx` id only. Adding `@username` / page-id resolution belongs in a separate `channels-multichannel` spec.
- **No copy refresh in `channels.ts` / `auth/login.ts` strings** that currently say "WhatsApp channels" or "Shared WhatsApp Number". Those live in the `channels` family code path and remain correct for today's `channels list` behavior. They migrate when `channels` becomes multi-channel.
- **No `--json` mode determinism audit of `billing upgrade` or `workspace remove-member`.** Both prompt unconditionally today. Deterministic-flag-or-fail behavior is the right end state but is a separate audit.
- **No IG end-to-end integration test against staging.** The existing `test-integration/global-setup.ts` harness provisions WorkOS users but has no deterministic IG-session seed path; creating an IG session requires a real Instagram DM or the dashboard demo-handoff flow. Backend integration tests cover the IG bind-consume contract. CLI coverage is unit + command-runner tests in this phase. A `/internal/e2e/seed-sandbox-session` follow-up can unlock IG integration coverage later.
- **No `sandbox start` "show both WA and IG QRs side-by-side" auto-mode.** `--type` is an explicit chooser; mixing both was considered and rejected for surface-area reasons.

## Decisions

### D1. `sandbox start` becomes a channel chooser, with both paths first-class.

`hookmyapp sandbox start --type=whatsapp|instagram` selects the bind flow. The interactive TTY path prompts when `--type` is omitted; `--json` mode requires the flag (returns `ValidationError` exit 2 otherwise) — matches the existing CLI convention of deterministic-flag-required-in-non-TTY (`sandbox env --write` already follows this).

The Instagram path mirrors WhatsApp's structurally: print the bind code, render a QR + raw deep-link to `https://ig.me/m/{handle}?text={encodedCode}`, poll `GET /sandbox/bind-code` every 2s, on consumption fetch and announce the session.

The `ig.me` URL drops the `@` from the handle path segment (`ig.me/m/hookmyappsandboxstaging`, not `ig.me/m/@hookmyappsandboxstaging`) and `encodeURIComponent()`s the code.

**Rejected alternative — WA-only `sandbox start`, route IG users to the dashboard demo handoff.** Smaller v1, but it forks the "sandbox" mental model into "CLI-bindable channels" (WhatsApp) and "dashboard-only channels" (Instagram). Users would have to context-switch into a browser to start a session, then back to the terminal to use it. Symmetric `--type` chooser is one extra Commander option for permanent symmetry.

**Rejected alternative — auto-detect and show both QRs side-by-side.** Discoverability win but doubles the terminal real estate `sandbox start` consumes, and creates a confusing race where the first DM (WA or IG) consumes the bind code and the other QR becomes garbage. `--type` makes the user's intent unambiguous.

### D2. Instagram env vars use the `INSTAGRAM_*` prefix, symmetric to `WHATSAPP_*`.

The IG env block is the same five lines as WhatsApp's:

```
VERIFY_TOKEN={hmacSecret}
PORT=3000
INSTAGRAM_API_URL={proxyBase}/v25.0
INSTAGRAM_ACCESS_TOKEN={accessToken}
INSTAGRAM_ACCOUNT_ID={instagramAccountId}
```

`INSTAGRAM_ACCOUNT_ID` is the sandbox IG business account id — env-shared (same value across all sessions in a given environment), same role as `WHATSAPP_PHONE_NUMBER_ID`. The IG Graph API version is hardcoded at `v25.0` (single constant `INSTAGRAM_GRAPH_VERSION` exported from `src/api/sandbox-session.ts`, imported by both the env builder and the send builder). WhatsApp's `whatsappApiVersion` is server-delivered because WA has a staggered-version rollout; IG does not have the same pattern, so a CLI release follows a Meta version bump.

**Rejected alternative — `IG_*` prefix.** Meta's own Graph docs use `IG_USER_ID` for the path segment. Shorter to type. But asymmetric with `WHATSAPP_*` (different word length, different mental anchor) and reads ad-hoc next to it. The asymmetry would compound when other channels arrive.

**Rejected alternative — `INSTAGRAM_BUSINESS_*` prefix.** Mirrors Meta's official product naming exactly, disambiguates from the consumer Instagram API. Most defensible for clarity in 2028. But verbose, and the disambiguation isn't needed: HookMyApp doesn't talk to the consumer Instagram API, and the surrounding `INSTAGRAM_API_URL` value already encodes the Graph endpoint.

### D3. Sandbox selectors unify under `--phone` | `--username` | `--session`. The selector value's shape implies the channel type; no `--type` filter flag exists for selection.

All four sandbox subcommand groups (`env`, `send`, `stop`, `webhook show/set/clear`, plus `listen` which already partly does this) accept any one of:

- `--phone <e164>` — WhatsApp session by phone (existing flag, unchanged behavior for WA)
- `--username <@handle>` — Instagram session by handle (new). Leading `@` is stripped during normalization; match is against non-null `instagramSenderUsername` only
- `--session <ssn_X>` — exact match by publicId (was already on `sandbox listen`; promoted to universal across all four subcommand groups)

At most one selector flag may be provided. Two or more → `ValidationError` exit 2 (`CONFLICTING_SELECTORS`). The picker is unified into one function (`src/commands/sandbox/picker.ts`) used by every sandbox subcommand including `sandbox-listen/picker.ts`. `renderSessionTable` shows `Type | Identifier | Status | Listener` columns instead of phone-only; `Listener` column stays for `sandbox-listen` (heartbeat-derived live/idle is computed always, displayed empty when `lastHeartbeatAt` is null).

`sandbox webhook show/set/clear` keep their positional `[phone]` argument in 0.13.0 with a stderr deprecation warning. Removed in 0.14.0. Positional + any selector flag together → `ValidationError` exit 2 (same `CONFLICTING_SELECTORS` code).

The login wizard's existing `--next sandbox --phone +X` legacy auto-listen path stays WhatsApp-only. After parsing wire sessions at the boundary, the wizard filters to `type === 'whatsapp'` before the legacy match — a parsed IG session cannot fall into the WA-only auto-listen code path by accident.

**Rejected alternative — `--type=whatsapp|instagram` + `--session` only.** More "uniform" on paper (one filter knob, one universal selector). But `--type` is a CLI-only abstraction; users never see the word "type" in the dashboard or in Meta's product surfaces. `--phone` and `--username` reuse vocabulary users already learned (those are the columns they read in the dashboard). Discoverability matters more than uniformity here, and the pattern still generalizes to one more channel before needing rework — Messenger would add `--page-id`, after which we'd revisit.

**Rejected alternative — `--username` for IG, `--phone` for WA, no `--session`.** Two selectors cover the 99% case. But edge cases exist: usernames may be null pre-backfill, IGSIDs collide with no other handle, scripts need a stable id that doesn't change when a user renames their IG account. `--session ssn_X` is the universal escape hatch for all such cases at the cost of one extra flag.

**Rejected alternative — overloaded positional `[identifier]` matching `+phone | @username | ssn_X` by shape (like `channels resolveChannel`'s WA-biased pattern at `channels.ts:90`).** Symmetric with the `channels *` family. But `sandbox` operates on a *session* that's frequently auto-picked (1 session = no prompt needed); flags fit better when arguments are optional. The two command families have different command shapes; the consistency benefit doesn't justify forcing one onto the other.

### D4. The IG env block does NOT include a hardcoded sender IGSID.

The WhatsApp env block does not include the tester's phone; the developer's webhook handler parses it from `entry[].changes[].value.contacts[].wa_id`. Instagram is the same: the handler parses the sender's IGSID from `entry[].messaging[].sender.id` in the inbound webhook. Hardcoding a per-session `INSTAGRAM_SENDER_ID` into `.env` would:

- Force a re-`sandbox env --write` whenever a different tester DMs the sandbox account
- Encourage "works in sandbox, fails in production" patterns where the developer reads `process.env.INSTAGRAM_SENDER_ID` instead of parsing the inbound payload
- Create a contract that doesn't generalize to real Instagram channels (which serve many senders, none of whom are env-fixed)

**Rejected alternative — include `INSTAGRAM_SENDER_ID` as a sixth env line.** Smoother first-five-minutes experience (no need to wire webhook parsing before sending a test reply). But the production handoff cost is real: developers ship a `.env`-reading reply path, then have to rewrite it when they go live. The cost is paid once in sandbox; better to pay it then than to delay it.

### D5. Shared CLI copy is channel-agnostic. Per-flag and per-channel help text stays specific.

Strings that appear in command descriptions or in error messages that fire for both channels say "sandbox session" or "channel", not "WhatsApp phone". For example:

- `sandbox start` description becomes `'Bind a sandbox session for local development'` (was `'Bind your WhatsApp phone to this workspace…'`)
- `NO_ACTIVE_SESSIONS` error becomes `'No active sandbox sessions. Run: hookmyapp sandbox start'` (was `'…--phone +<your-number>'`)
- Picker labels render via `sessionLabel(session)` → `WhatsApp +15551234567 (active)` or `Instagram @ordvir (active)`

Per-flag help stays specific because the flag *is* channel-specific:

- `--phone <e164>` help: `'Select WhatsApp session by phone'`
- `--username <@handle>` help: `'Select Instagram session by @handle'`
- `--session <ssn_X>` help: `'Select any session by id'`

The channel context lives in the flag name, not in duplicate per-channel error strings.

**Rejected alternative — list both channels everywhere ("Bind your WhatsApp or Instagram channel…").** Most discoverable for new users but verbose and needs maintenance every time a new channel arrives. Channel-agnostic shared strings + channel-specific flag help carries the same information once.

**Rejected alternative — branch help output and error messages on detected/selected channel context.** Most contextually accurate per-invocation. But Commander doesn't help-branch natively, the implementation is brittle (`--help` runs before any session lookup), and harder for users to read static docs that don't know which channel they want yet.

### D6. Delivery shape is a single PR landing the entire IG parity surface in `@gethookmyapp/cli` 0.13.0.

One coherent shipping unit: D3 selector unification + IG branches in `env`, `send`, `start`, `status`, `webhook`, `listen` + the boundary parser + the shared helpers + the `INSTAGRAM_GRAPH_VERSION` constant + the env-profile IG handle resolver. Users who upgrade to 0.13.0 get the full Instagram flow on the first invocation.

**Rejected alternative — split into two PRs (selector unification first, IG functionality second).** Smaller, independently reviewable. But the selector unification ships a `--username` flag users can't usefully invoke in the interim release; awkward shipping shape with no per-release win. The full parity PR is large but coherent.

**Rejected alternative — five small per-subcommand PRs.** Tiny review surface each. But the CLI passes through five transient states where IG support is partial; release notes have to explain which release unlocks which capability; users get confused.

### D7. Wire data is parsed at the boundary into a discriminated union; `as SandboxSession[]` casts are deleted.

A single hand-rolled parser (`src/api/sandbox-session.ts:parseSandboxSession(dto: unknown)` + plural `parseSandboxSessions`) validates the wire shape into a TypeScript discriminated union before any consumer touches the data:

```typescript
type SandboxSession = WhatsAppSandboxSession | InstagramSandboxSession;
```

WhatsApp variant requires non-empty `whatsappPhone` + `whatsappPhoneNumberId`. Instagram variant requires non-empty `instagramSenderId` + `instagramAccountId`; `instagramSenderUsername` may be null (backend backfills async via the IG name-resolution job; `--username` matching is null-aware per D3). Any malformed row → `UnexpectedError` with code `MALFORMED_SANDBOX_SESSION` (exit 1, semantic fit for "API returned a shape the CLI cannot process"). No `legacy phone → whatsappPhone` shim — per project memory `feedback_no_legacy_handling`, pre-production code does not write backfills; a backend STI violation surfaces immediately at the CLI rather than getting normalized away.

The parser is wired in at every site that fetches `/sandbox/sessions*`: env, send, start, status, stop, webhook, listen, and the login wizard's `runSandboxFlow`. No Zod dependency added — the parser is ~120 LOC, dependency-free, same style as `parseTimeArg` in `channels-logs/`.

**Rejected alternative — strict `as SandboxSession[]` cast (today's pattern, retained).** The compiler believes the union but the runtime doesn't enforce it. A backend bug produces "undefined is not a function" deep in a consumer; tested in production via the user's terminal. Discrimination loses its safety guarantee.

**Rejected alternative — Zod-based runtime validation.** Robust, well-known. But adds a runtime dependency to a publishable npm CLI for one type. The hand-rolled parser matches the existing repo convention (no Zod elsewhere) and stays maintenance-free.

**Rejected alternative — backward-compatible parser that falls back `whatsappPhone ?? phone` (legacy column accommodation).** Honest about pre-migration backend state. But the multi-channel-instagram milestone IS the STI cutover; the parser is the cleanest way to surface any backend miss as a loud error rather than papering over it. Per `feedback_no_legacy_handling`.

### D8. Shared helpers concentrate the type-narrow in one place per concept.

Three pure functions in `src/commands/sandbox/helpers.ts`:

- `sessionIdentifier(session): string` — `+15551234567` for WA, `@ordvir` for IG (falls back to IGSID when `instagramSenderUsername` is null)
- `sessionLabel(session): string` — `WhatsApp +15551234567 (active)` or `Instagram @ordvir (active)`
- `buildSandboxSendRequest(session, message): { url, body }` — returns the send URL + body. WA: `POST {proxy}/{whatsappApiVersion}/{sandboxPhoneNumberId}/messages` with `{ messaging_product, to, type:'text', text:{body} }`. IG: `POST {proxy}/{INSTAGRAM_GRAPH_VERSION}/{instagramAccountId}/messages` with `{ recipient:{id:instagramSenderId}, message:{text} }`.

Plus an `assertNever(value: never, ctx: string): never` exhaustiveness helper that throws `UnexpectedError` with the context string. Adding a third channel later = one new branch in each helper + the parser; every consumer compiles unchanged.

The `buildSandboxSendRequest` name is deliberate (rather than `sessionSendTarget`) — it acknowledges the side-effect of reading `getEffectiveSandboxProxyUrl()` (env-var lookup) inside the helper rather than claiming false purity.

### D9. Parser failures throw `UnexpectedError`, not `ValidationError` or `ApiError`.

`ValidationError` exits 2 and semantically means "user input is bad". The user cannot have caused malformed wire data, so exit 2 misclassifies the failure. `ApiError`'s constructor at `src/output/error.ts:200-207` auto-derives its code from the status (`>=500 → SERVER_ERROR`, else `API_ERROR`) and cannot carry a custom `MALFORMED_SANDBOX_SESSION` code. `UnexpectedError`'s constructor accepts a custom code, exits 1, and semantically fits "API returned a shape the CLI cannot process".

### D10. Production-environment Instagram start fails fast with `ConfigurationError`.

`getEffectiveSandboxInstagramUsername()` returns `'@hookmyappsandboxstaging'` for local + staging environments. In production it throws:

```typescript
throw new ConfigurationError(
  'Instagram sandbox is not configured for production yet. Use --type=whatsapp, or switch to staging/local.',
  'IG_SANDBOX_NOT_CONFIGURED_PROD',
);
```

The production IG sandbox handle is genuinely TBD per project memory `reference_sandbox_ig_account`. Shipping a placeholder value would silently produce a broken `ig.me` deep link that consumes a bind code that never gets matched. Fail-fast at the env-profile boundary is the right call.

`ConfigurationError`'s constructor at `src/output/error.ts:92-99` is positional `(message, code)`; the message is shown to the user verbatim via `outputError`. No `userMessage` field exists in this version of the constructor and no overload is added in this phase.

### D11. Selector-mismatch errors use the existing `CliError` + `exitCode = 2` pattern with code `SESSION_MISMATCH`.

`sandbox-listen/picker.ts:60-66` already throws:

```typescript
const err = new CliError(message, 'SESSION_MISMATCH');
err.exitCode = 2;
throw err;
```

The unified picker preserves this exact shape rather than switching to `ValidationError` (which would change the error code to `VALIDATION_ERROR` unless every call site supplied a custom code, breaking parity with the existing matching error already grep-able at one well-known site).

`--username` mismatch when all IG candidates have null `instagramSenderUsername` (still backfilling) gets a more specific message: `"Instagram session has no username yet (still resolving from Meta). Use --session <ssn_X> to select by id. Run: hookmyapp sandbox status to list."` — but uses the same `SESSION_MISMATCH` code so callers branching on `err.code` continue to work.

### D12. `sandbox webhook show/set/clear` positional `[phone]` argument is deprecated for one minor-release runway.

The 0.13.0 release accepts the positional argument and the three new flags (`--phone`, `--username`, `--session`). Positional alone emits a stderr deprecation warning, then executes normally (treated as `phoneFlag`). Positional + any selector flag together → `ValidationError` exit 2 with code `CONFLICTING_SELECTORS`. The 0.14.0 release removes the positional argument entirely. Runway shape mirrors the precedent set by the `hookmyapp env`/`token`/`health`/`webhook` top-level aliases in 0.12.1.

### D13. CLI-side integration coverage for IG is deferred.

`test-integration/global-setup.ts` provisions WorkOS users via `/internal/e2e/ensure-users` but has no deterministic IG-session seed endpoint. Creating an IG sandbox session today requires either a real Instagram DM consuming a bind code, or the dashboard's demo-handoff flow — neither is reproducible from CI. Backend integration tests at `backend/test/tests/sandbox/` already assert the IG bind-consume contract end-to-end.

The 0.13.0 merge bar is unit + command-runner test coverage for every branch point and every documented error pathway. A `/internal/e2e/seed-sandbox-session` follow-up on the backend can unlock CLI integration coverage later, if/when justified.

## Migration notes (preview — full table belongs in the plan)

- `src/commands/sandbox.ts` (782 LOC, mixed concerns) is split into `src/commands/sandbox/{index,env,send,start,status,stop,webhook,picker,helpers}.ts`. Matches `sandbox-listen/` precedent.
- NodeNext ESM does not resolve directories; every existing import that uses `./commands/sandbox.js` migrates to `./commands/sandbox/index.js`. Affected: `src/index.ts`, `src/auth/login.ts:420`, and every `vi.mock('../sandbox.js')` / `vi.mock('../../commands/sandbox.js')` across the test suite.
- `src/config/env-profiles.ts:125` has a pre-existing raw `throw new Error(...)`. While the file is already being modified to add `getEffectiveSandboxInstagramUsername`, the raw throw is converted to `ConfigurationError`. Minimal in-flight cleanup of a known lint violation.
- `package.json` version bumps to `0.13.0`; `CHANGELOG.md` gets a 0.13.0 entry naming the IG support + selector unification + `sandbox webhook` positional deprecation.

## Known issues out of scope (filed as follow-ups)

These were flagged during the brainstorm; each is real but outside this spec's surface:

- `channels resolveChannel()` at `channels.ts:90` is WhatsApp-biased. Workaround for IG users: pass `ch_xxx` id (channel-id resolution is type-agnostic).
- WhatsApp-flavored copy in `channels.ts` and `auth/login.ts` ("WhatsApp channels", "Shared WhatsApp Number") stays as-is; migrates when `channels` becomes multi-channel.
- `billing upgrade` prompts unconditionally in `--json` mode at `billing.ts:96`. Separate determinism audit.
- `workspace remove-member` / `workspace cancel-invite` print human text + exit 0 in `--json` when `--yes` is omitted. Same audit.
- `auth/login.ts` `--next sandbox` does not pass `--session` through to the sandbox-listen handler. Adding it would round out the universal-selector story but is not required for IG and was deferred.
