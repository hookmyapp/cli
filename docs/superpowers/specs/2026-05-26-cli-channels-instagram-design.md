# Instagram support in the HookMyApp CLI channels commands

**Status:** draft (2026-05-26)
**Scope:** Single repository (`/Users/ordvir/COD/cli`, published as `@gethookmyapp/cli`). No backend changes are introduced by this CLI spec — the wire shape is owned by the `multi-channel-instagram` backend worktree per project memory `project_channel_sti_worktree_scope`. CLI execution lands after that worktree merges to main.
**Target release:** `@gethookmyapp/cli` 0.13.0. Ships Instagram parity across every `channels` subcommand AND retrofits the sandbox subcommands to the same positional-with-shape-detection picker convention.

## Problem

The HookMyApp dashboard ships full Instagram channel support today (`frontend/src/types/channel.ts` defines `Channel = WhatsAppChannel | InstagramChannel | MessengerChannel`; the backend `channels` STI table accepts `type = 'instagram'` per CLAUDE.md). A customer who connects an Instagram channel through the dashboard can list it, see its delivery history, and configure its webhook — all in the browser.

The CLI is WhatsApp-only. Every `channels` subcommand (`list`, `show`, `connect`, `disconnect`, `enable`, `disable`, `env`, `token`, `health`, `webhook show/set/clear`, `channels listen`, `channels logs`) keys on WhatsApp fields (`phoneNumberId`, `displayPhoneNumber`, `wabaName`), and the picker (`resolveChannel`) only knows how to fuzzy-match against those WA shapes. An Instagram channel is reachable from the CLI by `ch_X` publicId only — and even then most subcommands either crash on missing WA fields or print misleading WA-flavored output.

The sandbox-IG milestone (`2026-05-25-instagram-sandbox-cli-design.md`) shipped the parser, helpers, and unified picker for sandbox sessions, and proved the discriminated-union pattern works for the CLI. That pattern now needs to extend to real channels — with the same product-grade UX the dashboard already gives Instagram users.

Separately, the sandbox subcommand picker convention (`--phone` / `--username` / `--session` flag-only) shipped 4 days ago without a positional shortcut. That was the wrong default: customers know their phone and username, not the auto-generated `ssn_X` id. This milestone fixes that for both surfaces at once so the CLI never carries two divergent picker conventions.

## Goals

- An Instagram channel is selectable, configurable, and operable from every `channels` subcommand with the same UX shape as a WhatsApp channel: pick it, show it, get its env vars, enable/disable forwarding, tunnel webhooks, browse logs, configure its webhook URL.
- `hookmyapp channels connect whatsapp` and `hookmyapp channels connect instagram` are both first-class — symmetric copy-paste-able commands, each opening the OAuth flow Meta hosts for that channel type.
- The CLI picker is unified around **shape-detected positional**: a bare `+E164` is a phone (WA only), `@handle` is an IG username, `ch_X` is a channel publicId, `ssn_X` is a sandbox session publicId. Same convention across `channels` and `sandbox` subcommands; same shared resolver. Sharp validator errors when the shape is malformed (e.g., bare digits without `+`).
- Wire data from `GET /meta/channels` and `GET /meta/channels/:id` is **parsed** at the boundary into a discriminated union mirroring `frontend/src/types/channel.ts`. The current `ApiChannel` type with its `[key: string]: unknown` escape hatch and untyped narrowing is deleted. Same discipline the sandbox spec applied to `SandboxSession`.
- The `channels env` command, already channel-type-agnostic by design (it delegates the env-shape decision to backend `GET /meta/channels/:id/env`), keeps that boundary intact — the CLI plan only adds an acceptance test that an IG channel returns `INSTAGRAM_*` keys.

## Non-goals

- **No retroactive `--via=<instagram_login|facebook_login>` flag on `channels connect instagram`.** Today there is one IG OAuth config; the CLI opens one URL. If we ever support a second IG sub-flow, `--via` becomes the gate then.
- **No removal of the deprecated positional `[phone]` argument on `sandbox webhook show/set/clear`.** That deprecation runway was set for 0.13.0; this milestone repurposes the positional to `[ssn_X | +phone | @username]` shape-detection instead of deleting it outright. The user-facing change is "the positional accepts more shapes now"; the deprecation warning text is updated accordingly.
- **No deprecation of the existing `--phone` / `--username` / `--session` flags on sandbox subcommands.** They remain as the typed-fallback path for the rare cases where shape detection is ambiguous (e.g., a customer pipes a value through a script that strips the `+` prefix; the flag lets them be explicit). The dominant path becomes positional with shape detection; flags are the safety net.
- **No CLI change for `channels env` payload shape.** Backend owns the per-type env block; CLI is already pass-through. The plan adds an acceptance test, nothing more.
- **No "list all channels including Instagram in one combined table" redesign.** `channels list` today renders WA-shaped columns. For IG rows it'll show channel-type, identifier (handle / phone / wabaName per type), publicId, and forwarding state. The table is the same surface; per-type columns narrow at render time. No separate `channels list --type=instagram` filter — that's `grep`-able from `--json` output.
- **No new "coexistence merger" command.** When `channels connect whatsapp` completes and Meta's coexistence flow returns both a WA and an IG channel, CLI just reports both in the post-connect summary. No `channels link` / `channels unlink` for joining/splitting channel pairs.
- **No multi-channel E2E test against staging.** Existing `test-integration/` harness doesn't have a deterministic IG-channel seed path. Coverage is unit + command-runner tests; staging exercise is part of the rollout playbook, not CI.

## Decisions

### D1. Full parity — every WA `channels` subcommand gets an IG counterpart.

All ~12 subcommands (`list`, `show`, `connect`, `disconnect`, `enable`, `disable`, `env`, `token`, `health`, `webhook show/set/clear`, `channels listen`, `channels logs`) work with Instagram channels in v1. Same flag surface, same exit codes, same JSON shape per type.

**Rejected alternative — debug-mode subset** (skip `connect/disconnect/enable/disable/token` for IG, defer to GUI). Smaller plan, but it ships a partial CLI surface that customers will instantly trip over the first time they try `channels disconnect @ordvir`. "The dashboard supports it but the CLI doesn't" is a product anti-pattern — it makes the CLI feel half-finished and forces channel-type-aware muscle memory ("for IG I have to use the dashboard for that one"). The connect flow being painful to port is a real cost, but it's a one-time engineering cost; the half-finished-CLI cost is recurring forever.

**Rejected alternative — listen/logs/env only** (just the three AI-agent debug commands). Even smaller, even more obviously partial. Customers building IG apps need the full operational surface, not just the read commands.

### D2. `channels connect` becomes an explicit per-type chooser.

`hookmyapp channels connect whatsapp` opens Meta Embedded Signup (covers cloud_api and coexistence — Meta presents the picker in the browser). `hookmyapp channels connect instagram` opens the single configured IG OAuth URL. No `--via` sub-flag for the IG side; the current product reality is one IG OAuth config.

In both flows, post-connect the CLI polls `GET /meta/channels` and reports every channel that appeared during the polling window. The coexistence case — one OAuth flow registers both a WA and an IG channel — is reported naturally as `✓ Connected: WhatsApp +972... + Instagram @handle`.

Non-TTY behavior: `channels connect` (any type) throws `ValidationError` with exit 2 — connect requires a browser launch. Scripts that need programmatic channel creation should call the backend API directly. This mirrors every other OAuth CLI (`gh auth login`, `stripe login`, `gcloud auth login` all refuse without a terminal).

**Rejected alternative — single `channels connect`, browser-orchestrated** (no positional, opens one URL that lets the customer pick WA / IG-direct / FB-page in the browser). Cleanest from a CLI surface standpoint but assumes Meta supports a unified entry-point URL across channel types — they don't today, and historically have shipped each connect flow at its own URL with its own UX. Wiring the CLI to a fiction Meta doesn't honor would force a per-Meta-change CLI release every time they reshape the picker.

**Rejected alternative — `channels connect instagram --via=<instagram_login|facebook_login>`** (explicit sub-flow flag). YAGNI — one IG config today, no second flow on the roadmap. If a second flow ships, `--via` becomes the gate then with no breakage (no flag today → no callers to migrate).

### D3. Shape-detected positional picker, applied uniformly to `channels` and `sandbox`.

The picker for every channels/sandbox subcommand that operates on a specific entity (so: everything except `list`, `status`, `start`) accepts a single positional whose shape determines the identifier type:

- `+E164` → WhatsApp phone (e.g., `+972545434384`) — narrows to WA channels/sessions
- `@handle` → Instagram username (e.g., `@ordvir`) — narrows to IG channels/sessions
- `ch_X` → channel publicId — exact match on `channels` rows
- `ssn_X` → sandbox session publicId — exact match on `sandbox sessions` rows

`--phone` / `--username` / `--session` / `--channel` flags stay as a typed-fallback path. They remain for:

- Customers piping values through a script that strips the leading `+` or `@`
- Programmatic agents that prefer flag-based parameter passing
- Edge cases where the positional shape is genuinely ambiguous (none today, but defends against future shape collisions)

A bare positional with a shape outside the four recognized prefixes throws `ValidationError` (exit 2) with a sharp suggestion: `"972545434384" is not a recognized identifier shape. Did you mean +972545434384 (phone) or @ordvir (Instagram)?`

This applies as a retrofit to the **sandbox** subcommands shipped 4 days ago. The deprecated `[phone]` positional on `sandbox webhook show/set/clear` is repurposed (not removed) to `[+phone | @username | ssn_X | ch_X]`. The deprecation runway already promised "removed in 0.13.0" — this is the 0.13.0 change, but the positional stays, just smarter.

**Rejected alternative — flag-only, no positional.** What sandbox ships today. Verbose for the dominant case (`sandbox send --phone +972... --message "hi"` vs `sandbox send +972... --message "hi"`), forces customers to learn a flag vocabulary on top of identifier shapes they already know. Best-practice CLI patterns (`git checkout <ref>`, `gh issue view <number-or-url>`, `docker stop <container>`, Stripe `customers retrieve cus_X`) all favor positional when the identifier shape is self-identifying.

**Rejected alternative — positional canonical id only** (`channels disconnect ch_X` / `sandbox send ssn_X`, no shape detection). Cleanest from a parser standpoint and matches Stripe's pattern, but assumes customers know their `ch_X` / `ssn_X` id — they don't. The dashboard surfaces phone / handle / wabaName; the publicId only appears in URLs that customers rarely think about as identifiers. Forcing customers to copy `ssn_X` out of `sandbox status` output before they can run `sandbox send` adds friction for the dominant case to optimize for the rare case (scripts that have an id from a previous JSON parse).

**Rejected alternative — positional with fuzzy free-form matching** (today's `channels disconnect <phone-or-name-or-substring>`, expanded to handle IG). Works for WA-only because phone digits + WABA names are visually distinct. Becomes ambiguous the moment IG handles enter the picture (an `@`-less handle fragment overlaps with WABA name fragments overlap with phone substrings). Sharp shape detection beats fuzzy free-form once identifier types diversify.

### D4. CLI `Channel` type mirrors frontend's discriminated union exactly.

The CLI's `Channel` is `WhatsAppChannel | InstagramChannel | MessengerChannel` discriminated by `type`, matching `frontend/src/types/channel.ts` field-for-field. A `parseChannel(dto)` boundary parser at `src/api/channel.ts` validates wire data on the way in; the existing `ApiChannel` interface with its `[key: string]: unknown` escape hatch is deleted.

Same pattern as the sandbox-IG parser at `src/api/sandbox-session.ts`. Parser failures throw `UnexpectedError` with code `MALFORMED_CHANNEL`, mirroring `MALFORMED_SANDBOX_SESSION`.

Reasoning: the `[key: string]: unknown` escape hatch on today's `ApiChannel` lets the CLI accidentally read fields the backend doesn't promise (and lets the backend rename fields the CLI silently depends on). The boundary parser converts every silent contract violation into a loud crash with a stable error code — same discipline the sandbox parser made explicit.

### D5. `channels env` is unchanged at the CLI layer.

`src/commands/env.ts` is already channel-type-agnostic — it pulls `{ values, defaults }` from `GET /meta/channels/:id/env` and writes verbatim. The backend ships the IG branch of that endpoint (returning `INSTAGRAM_*` keys when `channel.type === 'instagram'`) as part of the multi-channel-instagram backend milestone. CLI gets zero net code change for `channels env`; the plan adds one acceptance test that an IG channel returns the expected key set.

### D6. `channels connect` non-TTY behavior: refuse with exit 2.

`hookmyapp channels connect <type>` in a non-TTY environment throws `ValidationError` (`CONNECT_REQUIRES_TTY`, exit 2). Connect inherently requires a browser launch, OAuth handshake, and post-flow polling — none of which compose with CI/scripting. Programmatic channel creation should hit the backend API directly.

Mirrors `gh auth login` (refuses headless), `stripe login` (refuses headless), `gcloud auth login` (refuses headless). Establishes the convention that any CLI subcommand requiring a browser explicitly refuses headless rather than silently launching xdg-open and timing out.

### D7. Coexistence multi-channel reporting.

When `channels connect whatsapp` returns both a WA and an IG channel from a coexistence OAuth flow, CLI reports both in the post-connect summary line:

```
✓ Connected:
    WhatsApp  +972545434384  (ch_aaaaaaaa)
    Instagram @hookmyappdemo (ch_bbbbbbbb)
```

No separate `channels link` / `channels unlink` command. The two channels are independent rows in the `channels` table per the STI design; their pairing relationship is a backend concern, not surfaced in the CLI today.

### D8. `channels listen` and `channels logs` extend symmetrically.

Both commands already use the channel picker — they inherit D3's shape-detected positional change for free. The render logic narrows on `channel.type`:

- `channels listen` IG branch: stream the same `webhook_events` rows as WA; the only render difference is the per-event "sender" column showing `@username` for IG vs `+phone` for WA. Helper `sessionIdentifier()` from the sandbox-IG work generalizes to a `channelIdentifier()` for this.
- `channels logs` IG branch: same. WA-shaped delivery row gets a sibling IG-shape branch; both narrow at render time.

No new flags. No new env vars. Same tunnel mechanism, same SSE stream, same deliveries-list endpoint.

### D9. Sandbox retrofit lands first in the plan.

The plan's first phase is the picker convention retrofit on sandbox (positional shape-detected on all 8 sandbox subcommands that take a session selector + the shared `parseIdentifier()` helper). Reasons:

1. Establishes the shared helper that channels then reuses, so both surfaces consume the same parser from day one.
2. Lets us ship the sandbox UX fix immediately even if the channels-IG backend work slips — the sandbox retrofit is unblocked by anything.
3. The channels-IG plan inherits a tested picker convention rather than introducing it mid-milestone.

If the backend channels STI worktree merges before the CLI plan starts, both happen in one PR. If not, the sandbox retrofit ships as 0.12.3 and the channels-IG work ships as 0.13.0 when the backend is ready.

## Release strategy

Single PR if backend channels STI is on main when CLI plan starts. Two PRs (sandbox retrofit → 0.12.3, channels-IG → 0.13.0) if backend is still on a feature worktree. Either way the CLI's picker convention unification happens in one commit so we never have a snapshot where channels and sandbox use different picker shapes.

The deprecation warnings on top-level aliases (`hookmyapp env`, `hookmyapp token`, `hookmyapp health`, `hookmyapp webhook show/set`) and on the soon-to-be-deleted `[phone]` positional on `sandbox webhook` are inherited from the sandbox-IG spec; this milestone keeps the same warning text and the same "removed in next major" runway.
