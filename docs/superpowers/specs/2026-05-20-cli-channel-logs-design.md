# CLI channels logs: read channel delivery history without listening

**Status:** approved (2026-05-20)
**Scope:** One repository. CLI repo (`/Users/ordvir/COD/cli`, published as `@gethookmyapp/cli`) — new `channels logs` command group. No backend, frontend, or terraform changes: the `GET /deliveries` API already exists (monorepo Phase 131).
**Target release:** next CLI minor.

## Problem

The CLI surfaces webhook traffic through exactly one path today: the live
streaming `listen` commands (`channels listen`, `sandbox listen`). To see
what a channel actually received and forwarded, a user must either keep a
`listen` session open from the moment a webhook arrives, or open the web
app's "Channel Logs" page (`DeliveriesPanel`).

That is a real gap for the CLI's growing agentic audience. A developer who
wants to point their own cloud, Codex, or any agent at a debugging task
cannot say "check the channel logs" — there is no non-interactive,
non-streaming command that returns delivery history. The data already
exists: every inbound webhook and forward attempt is persisted to
`webhook_events` + `webhook_delivery_attempts` and served by the backend
`GET /deliveries` API that powers the web UI panel. The CLI just never
exposed it.

## Goals

- A user (or an agent acting for them) can run a single non-interactive
  command to list a channel's recent webhook deliveries — status, source
  phone, forward result — without opening a `listen` session or the web UI.
- A user can drill into one delivery and see the full inbound body, the
  forward request, and the customer app's response — the same information
  the web UI's expanded delivery row shows.
- The command is agent-friendly: `--json` returns structured,
  API-compatible output (raw API body single-page, aggregated under
  `--all` — see D5) so an agent can filter and reason over it.
- The CLI behaves as the read-only history sibling of `channels listen`:
  `listen` receives live traffic, `logs` reads what already happened.

## Non-goals

- **Streaming / follow mode.** No `--watch` or `--follow`. "Read the logs
  without listening" means a snapshot fetch. A follow flag would be a worse
  reimplementation of `channels listen`, which already owns live traffic.
- **Workspace-wide / cross-channel list view.** The existing
  `GET /deliveries` list API requires a mandatory per-channel (or
  per-sandbox-session) `scope`, so `channels logs list` is channel-scoped
  only. An all-channels list view would need a new backend endpoint and is
  explicitly deferred. (`channels logs show <id>` is workspace-scoped — see
  D3 — because the detail endpoint addresses a delivery by ID; that is not
  a cross-channel *list* and is in scope.)
- **Sandbox-session logs.** `GET /deliveries` also accepts a
  `sandbox-session:<publicId>` scope, but `channels logs` covers real
  channels only. Sandbox traffic is already served by `sandbox listen`.
- **Server-side or rich client-side filtering.** No `--status`, `--failed`,
  or text-search flags (see D7).
- **Any backend, frontend, or infrastructure change.** This is a pure
  CLI-side feature against an API that already ships in production.

## Decisions

### D1. New `channels logs` command group mirroring the web UI Channel Logs page.

The web app's "Channel Logs" page (`frontend/src/pages/channel-logs.tsx` →
`DeliveriesPanel`) does two things: it lists a channel's deliveries, and it
expands any row into a three-section detail view. `channels logs` mirrors
that feature for the terminal, minus the live SSE stream the panel also
runs. It is the read-only history counterpart to `channels listen`.

The command group has two leaf verbs:

```
hookmyapp channels logs list <channel>     # list view — channel-scoped
hookmyapp channels logs show <id>          # detail view — workspace-scoped
```

`list`'s `<channel>` argument resolves through the existing
`resolveChannel()` helper, so it accepts a `ch_xxxx` public ID, a phone
number, or the interactive picker — identical to every other `channels`
subcommand.

`show` takes a bare delivery `id` and no channel argument. The `id` is
exactly the `ID` value printed by `list`, so the workflow is
`list <channel>` → copy an ID → `show <id>`. `show` is workspace-scoped,
not channel-scoped, because the backend detail endpoint addresses a
delivery by ID within the workspace (see D3). That list-then-drill-in loop
is the command's core ergonomic.

### D2. Pure CLI feature — reuse the existing `GET /deliveries` API.

`list` calls `GET /deliveries?scope=channel:<publicId>&...`; `show` calls
`GET /deliveries/<id>`. Both are already `WorkspaceGuard`-protected and are
the exact endpoints the web UI panel consumes. The detail endpoint resolves
a delivery by ID scoped to the authenticated workspace and the retention
floor — it applies no channel filter, which is why `show` takes no
`<channel>` argument (D3). No backend, Prisma, or terraform work is in
scope. The CLI authenticates with the credentials it already stores.

### D3. `list` is channel-scoped; `show` is workspace-scoped.

`list` is channel-scoped: the `GET /deliveries` `scope` parameter is
mandatory and addresses a single channel. A workspace-wide "all channels"
list view was considered and rejected for this iteration — it would require
a new backend query path, and the agentic debugging use case ("check this
channel's logs") is inherently channel-scoped, the agent already knows
which integration it is debugging.

`show` is workspace-scoped: `GET /deliveries/:id` resolves a delivery by ID
within the authenticated workspace (and the retention floor), with no
channel filter. Adding a `<channel>` argument to `show` for signature
symmetry with `list` was considered and rejected: the backend would ignore
it, so the argument would falsely imply a scoping that does not happen — a
user could pass channel A together with an event ID belonging to channel B
in the same workspace and receive B's detail. No security boundary is
crossed (the workspace guard still applies), but the command signature must
not lie about its scope. `show` therefore takes the bare delivery `id`.

### D4. Explicit `list` / `show` verbs; `logs` is a pure command group.

`channels logs` is a group with two verb subcommands, not a single command
that switches behavior on argument count. Considered and rejected: an
optional positional, where `channels logs <channel>` lists and
`channels logs <channel> <id>` shows detail.

Reasons for explicit verbs:

- **Industry convention.** `gh run list` / `gh run view`, `kubectl get` /
  `describe`, `stripe charges list` / `retrieve`. Top-tier CLIs do not
  overload argument arity to switch operations.
- **Codebase consistency.** The CLI already uses verb groups everywhere —
  `channels webhook show` / `channels webhook set`, plus `channels list`,
  `channels show`, `channels connect`. An optional positional would be the
  one inconsistent command in the tool.
- **Failure modes.** Arity overloading makes a typo'd channel reference
  look like a detail request, and `--help` cannot cleanly document two
  modes of one command.
- **Extensibility.** A verb group leaves room for `channels logs replay`,
  `channels logs export`, etc. without restructuring.

`channels logs` has no default subcommand. `channels listen` is a leaf;
`channels logs` is a group. Mixing "group with a default action" was
rejected as the kind of subtle inconsistency that bites later.

### D5. Human-readable output by default; `--json` for agents.

Default output is human-readable, rendered through the CLI's existing
`output()` helper. The global `--json` flag switches to structured output
for agent consumption. An agent invocation is simply
`channels logs list ch_xxxx --json`.

JSON is deliberately *not* the default, and TTY auto-detection (JSON when
piped) is rejected: it would break the human-at-a-terminal case and would
be the only command in the CLI behaving that way. Auto-detection is fragile
and surprising. An explicit flag is one token for an agent and zero
surprise for a human.

The `--json` shapes are:

- **`show --json`** — an exact passthrough of the `GET /deliveries/:id`
  response body.
- **`list --json`** — always `{ deliveries, nextCursor, floorHours }`. In
  single-page mode (no `--all`) this is the `GET /deliveries` response body
  verbatim. In `--all` mode `deliveries` is the concatenation of every
  fetched page, `floorHours` is taken from the first page, and `nextCursor`
  is `null` when the result set was fully exhausted or the continuation
  cursor when the 1000-row cap stopped collection early. There is no
  separate `truncated` or `fetchedCount` field: a non-null `nextCursor`
  after `--all` is itself the "capped, more available" signal — feed it
  back via `--cursor` — and `deliveries.length` is the count.

### D6. `list` flags map directly to `ListDeliveriesDto`.

| Flag | API field | Notes |
|---|---|---|
| `--limit <n>` | `limit` | 1–100, default 50 (matches API default and UI page size) |
| `--since <t>` / `--until <t>` | `since` / `until` | Accepts ISO-8601 or a relative shorthand (`30m`, `2h`, `7d`) converted to ISO-8601 client-side before the request |
| `--cursor <c>` | `cursor` | Continue from a prior page's `nextCursor`, which is exposed in both human and JSON output — enables scripted pagination |
| `--all` | (none) | Convenience: auto-follow `nextCursor` to exhaustion, hard-capped at 1000 rows so a misfire cannot run away. The one-shot path for "agent, check the logs". See D5 for the aggregate `--json` shape |

`show` flags: `--json` (full passthrough including all headers), and
`--verbose` to include `inboundHeaders` / `forwardRequestHeaders` in the
*human* detail view. Headers are omitted from the default human view to
keep the three-section layout readable; they are always present in `--json`
output regardless of `--verbose`.

### D7. No status filter, no search — JSON is the filtering surface.

`channels logs list` ships no `--status`, `--failed`, `--messages`, or
text-search flag. Reasons:

- The `GET /deliveries` API has no server-side status filter, so any filter
  would run client-side.
- Client-side filtering fights cursor pagination: filtering a 50-row page
  can yield zero matches while matches exist on later pages, producing
  misleading "empty" results.
- The web UI only gets away with client-side filtering because it prefetches
  every visible row's full detail into memory — not worth replicating in a
  CLI.
- The agent path is
  `channels logs list --json | jq '.deliveries[] | select(...)'` — the
  `list --json` shape is `{ deliveries, nextCursor, floorHours }` (D5), so
  row filtering reaches into `.deliveries[]`. That is the intended, robust
  filtering surface.

### D8. Output shapes mirror the web UI.

**`list` (human)** — a table rendered by `output()`, precedent set by
`channels list`:

```
ID          Received    Status              From            Forwarded  Attempts
evt_a1b2c3  2m ago      Delivered           +972545434384   200        1
evt_d4e5f6  14m ago     Your app errored    +972545434384   500        3
evt_g7h8i9  1h ago      No destination set  +14155550100    —          0
```

`Status` is the server-rendered `humanStatus`. The longer `humanStatusCopy`
sentence is too wide for a table cell and appears only in detail. The `ID`
column value is exactly the `show` argument.

**`list` (JSON)** — `{ deliveries, nextCursor, floorHours }`; verbatim API
body in single-page mode, aggregated across pages under `--all` (D5).

**`show` (human)** — mirrors the UI's three sections:

```
Delivery evt_a1b2c3   ·   2026-05-20 14:32:07Z   ·   from +972545434384
Routing: forwarded   Signature: ok   Sandbox: no

What WhatsApp sent us
  { ...inboundBody pretty-printed... }

We sent it to your app
  POST https://customer.app/webhook
  { ...forwardRequestBody... }

Your app responded
  500  ·  842ms
  { ...forwardResponseBody... }
```

Multiple forward attempts print as repeated "We sent…/responded" block
pairs. The no-destination case prints the same explanatory note the UI
shows in place of sections two and three.

**`show` (JSON)** — raw `GET /deliveries/<id>` body passthrough.

**Bodies are printed in full, unredacted.** This matches the web UI
Deliveries panel exactly: same workspace owner, same data, same Phase 131
retention contract. The `redactBody` PII rule applies only to the shared
Cloud Logging / Sentry firehose, not to this owner-facing surface. If the
API marks `inboundBodyTruncated`, the CLI prints a `(truncated)` marker.

### D9. Retention floor surfaced as a one-line note.

The `GET /deliveries` list response carries `floorHours`, and the API
silently clamps a `--since` older than the workspace plan's retention
window. When a requested `--since` is actually clamped, the CLI prints a
single-line note — e.g. `Showing last 168h (plan retention limit).` —
mirroring the web UI's `PlanFloorBanner`. When `--since` is within the
floor, no note is printed.

### D10. Errors and exit codes use the CLI's existing error classes.

- Unknown channel or channel outside the workspace: `resolveChannel()`
  already throws a clean error.
- `show` with a bad or retention-expired ID: the API throws
  `DELIVERIES_NOT_FOUND`; the CLI surfaces "Delivery not found or outside
  retention window" and exits non-zero.
- No deliveries found: a friendly "No deliveries in the last 168h for this
  channel." message, exit code **0** — an empty result is not an error.
- Not authenticated: the CLI's existing auth flow handles it.

## Testing

Per CLI repo convention (`src/commands/__tests__/`), unit tests mock
`apiClient` and cover: list table rendering, `show` rendering including the
multi-attempt and no-destination cases, relative-time shorthand parsing,
`--all` pagination across multiple pages, the retention-floor note, the
empty result, and the not-found path. The `--json` output is asserted
against the verbatim API body for single-page `list` and for `show`, and
against the aggregate shape (D5) for `list --all`.

## Alternatives considered

- **Optional positional instead of `list`/`show` verbs** — rejected, see D4.
- **JSON output by default / TTY auto-detection** — rejected, see D5.
- **Workspace-wide all-channels view** — deferred, see D3; needs a new
  backend endpoint.
- **`--watch` / `--follow` streaming** — rejected, see Non-goals; that is
  `channels listen`.
- **`--status` / search filters** — rejected, see D7;
  `channels logs list --json | jq '.deliveries[] | select(...)'` is the
  filtering surface.
- **`<channel>` argument on `show`** — rejected, see D3; the detail endpoint
  is workspace-scoped, so the argument would falsely imply channel scoping.
