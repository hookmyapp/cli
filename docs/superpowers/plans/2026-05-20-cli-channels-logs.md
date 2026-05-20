# CLI `channels logs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `hookmyapp channels logs` command group that reads a channel's webhook delivery history (`list`) and one delivery's full detail (`show`) without an active `listen` session.

**Architecture:** Pure CLI-side feature against the existing `GET /deliveries` and `GET /deliveries/:id` backend API (monorepo Phase 131). A new `src/commands/channels-logs/` directory holds four focused modules — time parsing, API access, output rendering, and command wiring — registered under the existing `channels` command group. No backend, schema, or build-config changes.

**Tech Stack:** TypeScript, Commander v14, Vitest 3, the CLI's existing `apiClient` / `output()` / `AppError` infrastructure.

**Spec:** `docs/superpowers/specs/2026-05-20-cli-channel-logs-design.md`

---

## Background the engineer needs

- **The CLI repo is standalone** (`@gethookmyapp/cli`). The branch `feat/channels-logs` already exists and holds the spec commits — work continues on it.
- **`apiClient(path, { workspaceId })`** (`src/api/client.ts`) is the one HTTP entry point. It attaches auth, refreshes tokens, sends `X-Workspace-Id`, and maps non-2xx responses to typed `AppError` subclasses. A 404 becomes an `ApiError` with `.statusCode === 404`. It returns the parsed JSON body.
- **`resolveChannel(ref)`** (`src/commands/channels.ts`, exported) turns a user channel reference (`ch_xxxxxxxx`, phone, or name) into a full channel object `{ id, workspaceId, ... }` where `id` is the `ch_xxxxxxxx` public ID. It also calls `getDefaultWorkspaceId()` internally, which publishes the workspace into `apiClient`'s module context.
- **`getDefaultWorkspaceId()`** (`src/commands/_helpers.ts`, exported) resolves and returns the active workspace's public ID (`ws_xxxxxxxx`) — not a raw UUID; `_helpers.ts` explicitly rejects raw UUIDs. `show` needs it directly because `show` does not resolve a channel.
- **`output(data, opts)`** (`src/output/format.ts`): `output(x, { json: true })` prints `JSON.stringify(x, null, 2)`; `output(rows, { human: true })` prints a `cli-table3` table when `rows` is an array of flat objects.
- **`addExamples(cmd, text)`** (`src/output/help.ts`) attaches an `EXAMPLES:` block visible to both `--help` and `cmd.helpInformation()`.
- **`help.test.ts`** (`src/__tests__/help.test.ts`) walks **every** command in the program tree and asserts each exposes an `EXAMPLES:` section with **≥2** lines starting with `  $ hookmyapp `. Every new command (`logs`, `logs list`, `logs show`) MUST get an `addExamples()` call or this test fails.
- **Delivery IDs are plain UUIDs.** `WebhookEvent.id` is `String @id @default(uuid())`. There is no `evt_` prefix — the spec's `evt_a1b2c3` mockups are illustrative shorthand. Use realistic UUIDs in code and tests.
- **Backend wire contract** (`backend/src/deliveries/`): `GET /deliveries?scope=channel:<publicId>&limit=&since=&until=&cursor=` returns `{ deliveries: DeliveryListItem[], nextCursor: string | null, floorHours: number }`. `GET /deliveries/:id` returns `DeliveryDetail`. Both are `WorkspaceGuard`-protected. The DTO requires `since`/`until` as ISO-8601 and `limit` in `[1,100]`.
- **Tests** live under `src/__tests__/**` per `vitest.config.ts` (`include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/__tests__/**/*.{test,spec}.ts']`). New tests go in `src/__tests__/channels-logs/`.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/commands/channels-logs/time.ts` | Parse `--since`/`--until` (relative shorthand or ISO-8601) into ISO-8601. |
| `src/commands/channels-logs/api.ts` | Wire types + `fetchDeliveriesPage`, `fetchDeliveryDetail`, `fetchAllDeliveries`. |
| `src/commands/channels-logs/render.ts` | Human-readable rendering: list table rows + delivery detail. |
| `src/commands/channels-logs/index.ts` | `registerChannelsLogsCommand()` — Commander wiring + `list`/`show` action handlers. |
| `src/__tests__/channels-logs/time.test.ts` | Tests for `time.ts`. |
| `src/__tests__/channels-logs/api.test.ts` | Tests for `api.ts`. |
| `src/__tests__/channels-logs/render.test.ts` | Tests for `render.ts`. |
| `src/__tests__/channels-logs/list.test.ts` | Tests for the `channels logs list` command. |
| `src/__tests__/channels-logs/show.test.ts` | Tests for the `channels logs show` command. |

**Modify:**

| File | Change |
|---|---|
| `src/commands/channels.ts` | Import + invoke `registerChannelsLogsCommand`. |
| `README.md` | Add `channels logs` to the command examples. |

---

## Task 1: Time argument parsing (`time.ts`)

**Files:**
- Create: `src/commands/channels-logs/time.ts`
- Test: `src/__tests__/channels-logs/time.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/channels-logs/time.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseTimeArg } from '../../commands/channels-logs/time.js';
import { ValidationError } from '../../output/error.js';

describe('parseTimeArg', () => {
  const now = new Date('2026-05-20T12:00:00.000Z');

  it('resolves a relative hour shorthand against now', () => {
    expect(parseTimeArg('2h', now)).toBe('2026-05-20T10:00:00.000Z');
  });

  it('resolves a relative day shorthand against now', () => {
    expect(parseTimeArg('7d', now)).toBe('2026-05-13T12:00:00.000Z');
  });

  it('resolves relative minute and second shorthands', () => {
    expect(parseTimeArg('30m', now)).toBe('2026-05-20T11:30:00.000Z');
    expect(parseTimeArg('45s', now)).toBe('2026-05-20T11:59:15.000Z');
  });

  it('passes an ISO-8601 timestamp through, normalized to UTC', () => {
    expect(parseTimeArg('2026-05-19T08:30:00Z', now)).toBe(
      '2026-05-19T08:30:00.000Z',
    );
  });

  it('throws ValidationError on an unparseable value', () => {
    expect(() => parseTimeArg('yesterday', now)).toThrow(ValidationError);
  });

  it('throws ValidationError on a zero-unit relative value', () => {
    expect(() => parseTimeArg('2x', now)).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/time.test.ts`
Expected: FAIL — `Failed to resolve import "../../commands/channels-logs/time.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/channels-logs/time.ts`:

```typescript
import { ValidationError } from '../../output/error.js';

const RELATIVE_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Convert a `--since` / `--until` argument into an ISO-8601 string that the
 * `GET /deliveries` API accepts (its DTO validates with `@IsISO8601()`).
 *
 * Accepts either:
 *   - a relative shorthand `<n>s` / `<n>m` / `<n>h` / `<n>d`, resolved against
 *     `now` and always in the past, or
 *   - an absolute timestamp parseable by `Date` (ISO-8601 etc.).
 *
 * Throws `ValidationError` (exit 2) on anything else.
 */
export function parseTimeArg(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  const rel = RELATIVE_PATTERN.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    return new Date(now.getTime() - amount * UNIT_MS[rel[2]]).toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      `Invalid time value: "${value}". Use a relative shorthand (30m, 2h, 7d) ` +
        `or an ISO-8601 timestamp.`,
    );
  }
  return parsed.toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/time.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/time.ts src/__tests__/channels-logs/time.test.ts
git commit -m "feat(channels-logs): --since/--until time argument parsing"
```

---

## Task 2: Wire types + single-page / detail fetch (`api.ts`)

**Files:**
- Create: `src/commands/channels-logs/api.ts`
- Test: `src/__tests__/channels-logs/api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/channels-logs/api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock('../../api/client.js', () => ({ apiClient: mocks.apiClient }));

import {
  fetchDeliveriesPage,
  fetchDeliveryDetail,
} from '../../commands/channels-logs/api.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchDeliveriesPage', () => {
  it('builds a channel-scoped query and forwards the workspace id', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [],
      nextCursor: null,
      floorHours: 24,
    });

    await fetchDeliveriesPage({
      channelPublicId: 'ch_abc12345',
      workspaceId: 'ws_w1',
      limit: 50,
      since: '2026-05-19T00:00:00.000Z',
    });

    const [path, opts] = mocks.apiClient.mock.calls[0];
    expect(path).toMatch(/^\/deliveries\?/);
    expect(path).toContain('scope=channel%3Ach_abc12345');
    expect(path).toContain('limit=50');
    expect(path).toContain('since=2026-05-19T00%3A00%3A00.000Z');
    expect(opts).toEqual({ workspaceId: 'ws_w1' });
  });

  it('omits since/until/cursor when not provided', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [],
      nextCursor: null,
      floorHours: 24,
    });

    await fetchDeliveriesPage({
      channelPublicId: 'ch_abc12345',
      workspaceId: 'ws_w1',
      limit: 25,
    });

    const [path] = mocks.apiClient.mock.calls[0];
    expect(path).not.toContain('since=');
    expect(path).not.toContain('until=');
    expect(path).not.toContain('cursor=');
  });
});

describe('fetchDeliveryDetail', () => {
  it('GETs the workspace-scoped detail endpoint by id', async () => {
    mocks.apiClient.mockResolvedValue({ id: 'd1' });

    await fetchDeliveryDetail(
      '9b1f2e3d-4c5a-6789-0abc-def012345678',
      'ws_w1',
    );

    expect(mocks.apiClient).toHaveBeenCalledWith(
      '/deliveries/9b1f2e3d-4c5a-6789-0abc-def012345678',
      { workspaceId: 'ws_w1' },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/api.test.ts`
Expected: FAIL — `Failed to resolve import "../../commands/channels-logs/api.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/channels-logs/api.ts`:

```typescript
import { apiClient } from '../../api/client.js';

/** Wire mirror of backend `DeliveryListItem` (deliveries/dto/delivery.response.ts). */
export interface DeliveryListItem {
  id: string;
  receivedAt: string;
  fromPhone: string | null;
  routingDecision: string;
  attemptsCount: number;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusColor: 'green' | 'red' | 'gray';
  latestAttempt: {
    outcome: 'delivered' | 'no_response' | 'rejected' | 'skipped';
    forwardStatus: number | null;
    attemptedAt: string;
  } | null;
}

/** Wire mirror of backend `DeliveryAttemptResponse`. */
export interface DeliveryAttempt {
  id: string;
  attemptNumber: number;
  forwardUrl: string;
  forwardRequestHeaders: Record<string, string> | null;
  forwardRequestBody: string | null;
  forwardStatus: number | null;
  forwardDurationMs: number | null;
  forwardResponseHeaders: Record<string, string> | null;
  forwardResponseBody: string | null;
  forwardResponseBodySha256: string | null;
  forwardResponseBodyTruncated: boolean;
  outcome: string;
  outcomeReason: string | null;
  attemptedAt: string;
}

/** Wire mirror of backend `DeliveryDetail`. */
export interface DeliveryDetail {
  id: string;
  workspaceId: string;
  scopeKind: string;
  channelId: string | null;
  sandboxSessionId: string | null;
  providerObject: string;
  providerResourceId: string;
  metaMessageId: string | null;
  inboundBody: string | null;
  inboundBodySha256: string;
  inboundBodyTruncated: boolean;
  inboundHeaders: Record<string, string> | null;
  signatureOk: boolean;
  routingDecision: string;
  isSandbox: boolean;
  requestId: string | null;
  fromPhone: string | null;
  receivedAt: string;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusColor: 'green' | 'red' | 'gray';
  attempts: DeliveryAttempt[];
}

/** Wire mirror of the backend `GET /deliveries` list response. */
export interface DeliveriesPage {
  deliveries: DeliveryListItem[];
  nextCursor: string | null;
  floorHours: number;
}

export interface FetchDeliveriesParams {
  /** Channel public ID (`ch_xxxxxxxx`) — `scope` is always `channel:<id>`. */
  channelPublicId: string;
  workspaceId: string;
  limit: number;
  since?: string;
  until?: string;
  cursor?: string;
}

/**
 * Fetch a single page of channel deliveries from `GET /deliveries`. The list
 * endpoint is channel-scoped (spec D3): `scope` is always `channel:<publicId>`.
 */
export async function fetchDeliveriesPage(
  params: FetchDeliveriesParams,
): Promise<DeliveriesPage> {
  const query = new URLSearchParams({
    scope: `channel:${params.channelPublicId}`,
    limit: String(params.limit),
  });
  if (params.since) query.set('since', params.since);
  if (params.until) query.set('until', params.until);
  if (params.cursor) query.set('cursor', params.cursor);
  return (await apiClient(`/deliveries?${query.toString()}`, {
    workspaceId: params.workspaceId,
  })) as DeliveriesPage;
}

/**
 * Fetch one delivery's full detail from `GET /deliveries/:id`. The detail
 * endpoint is workspace-scoped (spec D3) — it resolves a delivery by id within
 * the workspace, so there is no channel argument.
 */
export async function fetchDeliveryDetail(
  id: string,
  workspaceId: string,
): Promise<DeliveryDetail> {
  return (await apiClient(`/deliveries/${encodeURIComponent(id)}`, {
    workspaceId,
  })) as DeliveryDetail;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/api.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/api.ts src/__tests__/channels-logs/api.test.ts
git commit -m "feat(channels-logs): wire types + single-page/detail fetch"
```

---

## Task 3: `--all` auto-paginating aggregator (`api.ts`)

**Files:**
- Modify: `src/commands/channels-logs/api.ts` (append)
- Test: `src/__tests__/channels-logs/api.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/channels-logs/api.test.ts`:

```typescript
import { fetchAllDeliveries, ALL_ROW_CAP } from '../../commands/channels-logs/api.js';

function rows(n: number, prefix: string): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

describe('fetchAllDeliveries', () => {
  const base = { channelPublicId: 'ch_abc12345', workspaceId: 'ws_w1', limit: 50 };

  it('follows nextCursor and concatenates every page', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({ deliveries: rows(50, 'a'), nextCursor: 'c1', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: rows(50, 'b'), nextCursor: 'c2', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: rows(10, 'c'), nextCursor: null, floorHours: 168 });

    const page = await fetchAllDeliveries(base);

    expect(page.deliveries).toHaveLength(110);
    expect(page.nextCursor).toBeNull();
    expect(page.floorHours).toBe(168);
    expect(mocks.apiClient).toHaveBeenCalledTimes(3);
  });

  it('stops at ALL_ROW_CAP and keeps a non-null nextCursor as the truncation signal', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: rows(100, 'p'),
      nextCursor: 'more',
      floorHours: 168,
    });

    const page = await fetchAllDeliveries({ ...base, limit: 100 });

    expect(page.deliveries).toHaveLength(ALL_ROW_CAP);
    expect(page.nextCursor).toBe('more');
  });

  it('passes the initial cursor through to the first request', async () => {
    mocks.apiClient.mockResolvedValue({ deliveries: [], nextCursor: null, floorHours: 24 });

    await fetchAllDeliveries({ ...base, cursor: 'start-here' });

    const [path] = mocks.apiClient.mock.calls[0];
    expect(path).toContain('cursor=start-here');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/api.test.ts`
Expected: FAIL — `fetchAllDeliveries`/`ALL_ROW_CAP` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/commands/channels-logs/api.ts`:

```typescript
/** Hard cap on rows collected by `--all`, so a misfire cannot run away. */
export const ALL_ROW_CAP = 1000;

/**
 * Auto-paginate `GET /deliveries` by following `nextCursor` until the result
 * set is exhausted or `ALL_ROW_CAP` rows are collected. The per-request limit
 * is clamped against the remaining cap so the total never overshoots, which
 * keeps the last page boundary exact: the returned `nextCursor` is non-null
 * iff rows remain beyond the cap (spec D5 — that is the truncation signal).
 * `floorHours` is taken from the first page.
 */
export async function fetchAllDeliveries(
  params: FetchDeliveriesParams,
): Promise<DeliveriesPage> {
  const deliveries: DeliveryListItem[] = [];
  let cursor: string | undefined = params.cursor;
  let floorHours = 0;
  let nextCursor: string | null = null;
  let firstPage = true;

  while (deliveries.length < ALL_ROW_CAP) {
    const pageLimit = Math.min(params.limit, ALL_ROW_CAP - deliveries.length);
    const page = await fetchDeliveriesPage({ ...params, limit: pageLimit, cursor });
    if (firstPage) {
      floorHours = page.floorHours;
      firstPage = false;
    }
    deliveries.push(...page.deliveries);
    nextCursor = page.nextCursor;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return { deliveries, nextCursor, floorHours };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/api.test.ts`
Expected: PASS — 6 tests (3 from Task 2 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/api.ts src/__tests__/channels-logs/api.test.ts
git commit -m "feat(channels-logs): --all auto-paginating aggregator with 1000-row cap"
```

---

## Task 4: List rendering (`render.ts`)

**Files:**
- Create: `src/commands/channels-logs/render.ts`
- Test: `src/__tests__/channels-logs/render.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/channels-logs/render.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { relativeTime, toListRows } from '../../commands/channels-logs/render.js';
import type { DeliveryListItem } from '../../commands/channels-logs/api.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function item(over: Partial<DeliveryListItem>): DeliveryListItem {
  return {
    id: 'd1',
    receivedAt: '2026-05-20T11:58:00.000Z',
    fromPhone: '+14155550100',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusColor: 'green',
    latestAttempt: { outcome: 'delivered', forwardStatus: 200, attemptedAt: '2026-05-20T11:58:01.000Z' },
    ...over,
  };
}

describe('relativeTime', () => {
  it('renders sub-minute deltas as "just now"', () => {
    expect(relativeTime('2026-05-20T11:59:30.000Z', NOW)).toBe('just now');
  });

  it('renders minute, hour and day buckets', () => {
    expect(relativeTime('2026-05-20T11:45:00.000Z', NOW)).toBe('15m ago');
    expect(relativeTime('2026-05-20T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(relativeTime('2026-05-18T12:00:00.000Z', NOW)).toBe('2d ago');
  });
});

describe('toListRows', () => {
  it('projects delivery items into flat table rows', () => {
    const rows = toListRows([item({ id: 'abc' })], NOW);
    expect(rows[0]).toEqual({
      ID: 'abc',
      Received: '2m ago',
      Status: 'Delivered',
      From: '+14155550100',
      Forwarded: 200,
      Attempts: 1,
    });
  });

  it('falls back to a dash for a missing phone or forward status', () => {
    const rows = toListRows(
      [item({ fromPhone: null, latestAttempt: null, attemptsCount: 0 })],
      NOW,
    );
    expect(rows[0].From).toBe('-');
    expect(rows[0].Forwarded).toBe('-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/render.test.ts`
Expected: FAIL — `Failed to resolve import "../../commands/channels-logs/render.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/channels-logs/render.ts`:

```typescript
import type { DeliveryListItem } from './api.js';

/**
 * Compact "time ago" label for the list table's `Received` column.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const sec = Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso).getTime()) / 1000),
  );
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Project delivery list items into flat rows for `renderTable`. `Status` is the
 * server-rendered `humanStatus`; the longer `humanStatusCopy` surfaces only in
 * `show` detail (spec D8).
 */
export function toListRows(
  deliveries: DeliveryListItem[],
  now: Date = new Date(),
): Record<string, unknown>[] {
  return deliveries.map((d) => ({
    ID: d.id,
    Received: relativeTime(d.receivedAt, now),
    Status: d.humanStatus,
    From: d.fromPhone ?? '-',
    Forwarded: d.latestAttempt?.forwardStatus ?? '-',
    Attempts: d.attemptsCount,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/render.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/render.ts src/__tests__/channels-logs/render.test.ts
git commit -m "feat(channels-logs): list table rendering"
```

---

## Task 5: Delivery detail rendering (`render.ts`)

**Files:**
- Modify: `src/commands/channels-logs/render.ts` (append)
- Test: `src/__tests__/channels-logs/render.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/channels-logs/render.test.ts`:

```typescript
import { renderDeliveryDetail } from '../../commands/channels-logs/render.js';
import type { DeliveryDetail, DeliveryAttempt } from '../../commands/channels-logs/api.js';

function attempt(over: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return {
    id: 'a1',
    attemptNumber: 1,
    forwardUrl: 'https://customer.app/webhook',
    forwardRequestHeaders: { 'content-type': 'application/json' },
    forwardRequestBody: '{"hello":"world"}',
    forwardStatus: 500,
    forwardDurationMs: 842,
    forwardResponseHeaders: { 'x-trace': 'abc' },
    forwardResponseBody: 'internal error',
    forwardResponseBodySha256: 'sha',
    forwardResponseBodyTruncated: false,
    outcome: 'rejected',
    outcomeReason: null,
    attemptedAt: '2026-05-20T11:58:01.000Z',
    ...over,
  };
}

function detail(over: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    id: 'd1',
    workspaceId: 'ws_w1',
    scopeKind: 'channel',
    channelId: 'chan-uuid',
    sandboxSessionId: null,
    providerObject: 'whatsapp_business_account',
    providerResourceId: 'r1',
    metaMessageId: 'm1',
    inboundBody: '{"entry":[]}',
    inboundBodySha256: 'sha',
    inboundBodyTruncated: false,
    inboundHeaders: { 'x-hub-signature-256': 'sig' },
    signatureOk: true,
    routingDecision: 'forwarded',
    isSandbox: false,
    requestId: 'req1',
    fromPhone: '+14155550100',
    receivedAt: '2026-05-20T11:58:00.000Z',
    humanStatus: 'Rejected',
    humanStatusCopy: "Your app got this, but couldn't process it",
    humanStatusColor: 'red',
    attempts: [attempt()],
    ...over,
  };
}

describe('renderDeliveryDetail', () => {
  it('renders the three sections for a forwarded delivery', () => {
    const out = renderDeliveryDetail(detail());
    expect(out).toContain('What WhatsApp sent us');
    expect(out).toContain('We sent it to your app');
    expect(out).toContain('POST https://customer.app/webhook');
    expect(out).toContain('Your app responded');
    expect(out).toContain('500');
    expect(out).toContain('842ms');
  });

  it('renders one block pair per attempt for a multi-attempt delivery', () => {
    const out = renderDeliveryDetail(
      detail({ attempts: [attempt({ attemptNumber: 1 }), attempt({ attemptNumber: 2 })] }),
    );
    expect(out.match(/We sent it to your app/g)).toHaveLength(2);
  });

  it('shows the no-destination note when a delivery has zero attempts', () => {
    const out = renderDeliveryDetail(detail({ attempts: [] }));
    expect(out).toContain('No destination was configured');
    expect(out).not.toContain('We sent it to your app');
  });

  it('treats a real-channel no_webhook_config delivery as no-destination', () => {
    const out = renderDeliveryDetail(
      detail({ routingDecision: 'no_webhook_config', attempts: [] }),
    );
    expect(out).toContain('No destination was configured');
  });

  it('omits headers by default and includes them when verbose', () => {
    expect(renderDeliveryDetail(detail())).not.toContain('x-hub-signature-256');
    expect(renderDeliveryDetail(detail(), { verbose: true })).toContain(
      'x-hub-signature-256',
    );
  });

  it('marks a truncated inbound body', () => {
    const out = renderDeliveryDetail(detail({ inboundBodyTruncated: true }));
    expect(out).toContain('(truncated)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/render.test.ts`
Expected: FAIL — `renderDeliveryDetail` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/commands/channels-logs/render.ts` (add `DeliveryAttempt, DeliveryDetail` to the existing type import — the first line becomes the block below):

```typescript
import type { DeliveryListItem, DeliveryAttempt, DeliveryDetail } from './api.js';
```

Then append these functions:

```typescript
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** Pretty-print a body string — JSON if parseable, verbatim otherwise. */
function prettyBody(body: string | null): string {
  if (body === null) return '  (no body)';
  if (body === '') return '  (empty)';
  try {
    return indentBlock(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    return indentBlock(body);
  }
}

function renderHeaders(headers: Record<string, string> | null): string {
  if (!headers || Object.keys(headers).length === 0) return '  (none)';
  return Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
}

function renderAttempt(att: DeliveryAttempt, verbose: boolean): string {
  const lines: string[] = ['', 'We sent it to your app', `  POST ${att.forwardUrl}`];
  if (verbose) {
    lines.push('  request headers:');
    lines.push(renderHeaders(att.forwardRequestHeaders));
  }
  lines.push(prettyBody(att.forwardRequestBody));

  lines.push('', 'Your app responded');
  const status = att.forwardStatus ?? '(no response)';
  const duration =
    att.forwardDurationMs !== null ? ` (${att.forwardDurationMs}ms)` : '';
  lines.push(`  ${status}${duration}`);
  if (verbose) {
    lines.push('  response headers:');
    lines.push(renderHeaders(att.forwardResponseHeaders));
  }
  lines.push(prettyBody(att.forwardResponseBody));
  if (att.forwardResponseBodyTruncated) lines.push('  (truncated)');
  return lines.join('\n');
}

/**
 * Render one delivery's full detail as the human view. Mirrors the web UI
 * Channel Logs expanded row (spec D8): inbound body, then per-attempt forward
 * request and app response.
 */
export function renderDeliveryDetail(
  detail: DeliveryDetail,
  opts: { verbose?: boolean } = {},
): string {
  const verbose = !!opts.verbose;
  const from = detail.fromPhone ? `from ${detail.fromPhone}` : 'from (unknown)';
  const lines: string[] = [
    `Delivery ${detail.id}   ${detail.receivedAt}   ${from}`,
    `Routing: ${detail.routingDecision}   ` +
      `Signature: ${detail.signatureOk ? 'ok' : 'MISMATCH'}   ` +
      `Sandbox: ${detail.isSandbox ? 'yes' : 'no'}`,
    `Status: ${detail.humanStatusCopy}`,
    '',
    'What WhatsApp sent us',
  ];
  if (verbose) {
    lines.push('  headers:');
    lines.push(renderHeaders(detail.inboundHeaders));
  }
  lines.push(prettyBody(detail.inboundBody));
  if (detail.inboundBodyTruncated) lines.push('  (truncated)');

  // The web UI keys the no-destination case off "zero forward attempts" (see
  // frontend `ExpandedDetail` in delivery-row.tsx), NOT off `routingDecision`.
  // Real channels with no usable destination emit `routingDecision`
  // `no_webhook_config` (forwarder/src/webhook/webhook.service.ts) — `channels
  // logs` is channel-scoped, so `no_destination` (the sandbox value) never
  // appears here. Branching on `attempts.length` mirrors the UI exactly and is
  // decision-string-agnostic, so it is correct for every zero-forward case.
  if (detail.attempts.length === 0) {
    lines.push('');
    lines.push(
      'Not forwarded. No destination was configured for this channel at the time.',
    );
    lines.push(
      'Set one with: hookmyapp channels webhook set <channel> --url <your-url>',
    );
  } else {
    for (const att of detail.attempts) lines.push(renderAttempt(att, verbose));
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/render.test.ts`
Expected: PASS — 10 tests (4 from Task 4 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/render.ts src/__tests__/channels-logs/render.test.ts
git commit -m "feat(channels-logs): delivery detail rendering"
```

---

## Task 6: `channels logs list` command (`index.ts`)

**Files:**
- Create: `src/commands/channels-logs/index.ts`
- Test: `src/__tests__/channels-logs/list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/channels-logs/list.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  apiClient: vi.fn(),
  resolveChannel: vi.fn(),
  getDefaultWorkspaceId: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  apiClient: mocks.apiClient,
  setWorkspaceContext: vi.fn(),
}));
vi.mock('../../commands/channels.js', () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock('../../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: mocks.getDefaultWorkspaceId,
}));

import { registerChannelsLogsCommand } from '../../commands/channels-logs/index.js';
import { ValidationError } from '../../output/error.js';

function listItem(id: string) {
  return {
    id,
    receivedAt: new Date().toISOString(),
    fromPhone: '+14155550100',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusColor: 'green',
    latestAttempt: { outcome: 'delivered', forwardStatus: 200, attemptedAt: new Date().toISOString() },
  };
}

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'json');
  const channels = program.command('channels');
  registerChannelsLogsCommand(channels, program);
  await program.parseAsync(['node', 'hookmyapp', 'channels', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveChannel.mockResolvedValue({ id: 'ch_abc12345', workspaceId: 'ws_w1' });
  mocks.getDefaultWorkspaceId.mockResolvedValue('ws_w1');
});

describe('channels logs list', () => {
  it('prints a table of deliveries for the channel', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [listItem('row-aaa'), listItem('row-bbb')],
      nextCursor: null,
      floorHours: 168,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('row-aaa');
    expect(out).toContain('row-bbb');
    log.mockRestore();
  });

  it('emits the raw API page verbatim under --json', async () => {
    const page = { deliveries: [listItem('row-aaa')], nextCursor: 'c1', floorHours: 24 };
    mocks.apiClient.mockResolvedValue(page);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345', '--json']);

    expect(log).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
    log.mockRestore();
  });

  it('prints a friendly message when there are no deliveries', async () => {
    mocks.apiClient.mockResolvedValue({ deliveries: [], nextCursor: null, floorHours: 24 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain(
      'No deliveries in the last 24h for this channel.',
    );
    log.mockRestore();
  });

  it('auto-paginates every page under --all', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({ deliveries: [listItem('p1')], nextCursor: 'c1', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: [listItem('p2')], nextCursor: null, floorHours: 168 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345', '--all']);

    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('p1');
    expect(out).toContain('p2');
    log.mockRestore();
  });

  it('rejects an out-of-range --limit', async () => {
    await expect(run(['logs', 'list', 'ch_abc12345', '--limit', '999'])).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an unparseable --since', async () => {
    await expect(
      run(['logs', 'list', 'ch_abc12345', '--since', 'yesterday']),
    ).rejects.toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/list.test.ts`
Expected: FAIL — `Failed to resolve import "../../commands/channels-logs/index.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/channels-logs/index.ts`:

```typescript
import type { Command } from 'commander';
import { output } from '../../output/format.js';
import { ValidationError } from '../../output/error.js';
import { addExamples } from '../../output/help.js';
import { resolveChannel } from '../channels.js';
import { parseTimeArg } from './time.js';
import {
  fetchDeliveriesPage,
  fetchAllDeliveries,
  type DeliveriesPage,
  type FetchDeliveriesParams,
} from './api.js';
import { toListRows } from './render.js';

interface ListOptions {
  limit?: string;
  since?: string;
  until?: string;
  cursor?: string;
  all?: boolean;
}

/** Validate `--limit` into the API's accepted `[1,100]` integer range. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ValidationError(
      `--limit must be an integer between 1 and 100 (got "${raw}").`,
    );
  }
  return n;
}

async function runChannelLogsList(
  channelRef: string,
  opts: ListOptions,
  json: boolean,
): Promise<void> {
  const limit = parseLimit(opts.limit);
  const since = opts.since ? parseTimeArg(opts.since) : undefined;
  const until = opts.until ? parseTimeArg(opts.until) : undefined;

  const channel = await resolveChannel(channelRef);
  const params: FetchDeliveriesParams = {
    channelPublicId: channel.id,
    workspaceId: channel.workspaceId,
    limit,
    since,
    until,
    cursor: opts.cursor,
  };

  const page: DeliveriesPage = opts.all
    ? await fetchAllDeliveries(params)
    : await fetchDeliveriesPage(params);

  if (json) {
    output(page, { json: true });
    return;
  }

  if (page.deliveries.length === 0) {
    console.log(`No deliveries in the last ${page.floorHours}h for this channel.`);
    return;
  }

  // Retention-floor note — only when an explicit --since was clamped (spec D9).
  if (since) {
    const floorBoundaryMs = Date.now() - page.floorHours * 3_600_000;
    if (new Date(since).getTime() < floorBoundaryMs) {
      console.log(`Showing last ${page.floorHours}h (plan retention limit).`);
    }
  }

  output(toListRows(page.deliveries), { human: true });

  if (page.nextCursor) {
    console.log('');
    console.log(`More deliveries available. Continue with: --cursor ${page.nextCursor}`);
  }
}
```

Then add the registration function:

```typescript
export function registerChannelsLogsCommand(
  channels: Command,
  program: Command,
): void {
  const logs = channels
    .command('logs')
    .description("Read a channel's webhook delivery history");

  const logsList = logs
    .command('list')
    .description('List recent webhook deliveries for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .option('--limit <n>', 'Max rows per page (1-100, default 50)')
    .option('--since <time>', 'Only deliveries after this time (ISO-8601 or 30m/2h/7d)')
    .option('--until <time>', 'Only deliveries before this time (ISO-8601 or 30m/2h/7d)')
    .option('--cursor <cursor>', 'Continue from a previous page nextCursor')
    .option('--all', 'Auto-paginate every page (capped at 1000 rows)')
    .action(async (channelRef: string, opts: ListOptions) => {
      await runChannelLogsList(channelRef, opts, !!program.opts().json);
    });

  addExamples(
    logs,
    `
EXAMPLES:
  $ hookmyapp channels logs list ch_AAAAAAAA
  $ hookmyapp channels logs show 9b1f2e3d-4c5a-6789-0abc-def012345678
`,
  );
  addExamples(
    logsList,
    `
EXAMPLES:
  $ hookmyapp channels logs list ch_AAAAAAAA
  $ hookmyapp channels logs list ch_AAAAAAAA --since 24h --all --json
`,
  );
}
```

> The `show` subcommand and its handler are added in Task 7. After this task, `index.ts` contains only the `logs` group and its `list` subcommand.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/list.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/index.ts src/__tests__/channels-logs/list.test.ts
git commit -m "feat(channels-logs): channels logs list command"
```

---

## Task 7: `channels logs show` command (`index.ts`)

**Files:**
- Modify: `src/commands/channels-logs/index.ts` (append)
- Test: `src/__tests__/channels-logs/show.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/channels-logs/show.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  apiClient: vi.fn(),
  resolveChannel: vi.fn(),
  getDefaultWorkspaceId: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  apiClient: mocks.apiClient,
  setWorkspaceContext: vi.fn(),
}));
vi.mock('../../commands/channels.js', () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock('../../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: mocks.getDefaultWorkspaceId,
}));

import { registerChannelsLogsCommand } from '../../commands/channels-logs/index.js';
import { ApiError, ValidationError } from '../../output/error.js';

const DETAIL = {
  id: 'd1',
  workspaceId: 'ws_w1',
  scopeKind: 'channel',
  channelId: 'chan-uuid',
  sandboxSessionId: null,
  providerObject: 'whatsapp_business_account',
  providerResourceId: 'r1',
  metaMessageId: 'm1',
  inboundBody: '{"entry":[]}',
  inboundBodySha256: 'sha',
  inboundBodyTruncated: false,
  inboundHeaders: null,
  signatureOk: true,
  routingDecision: 'forwarded',
  isSandbox: false,
  requestId: 'req1',
  fromPhone: '+14155550100',
  receivedAt: '2026-05-20T11:58:00.000Z',
  humanStatus: 'Delivered',
  humanStatusCopy: 'Delivered to your app',
  humanStatusColor: 'green',
  attempts: [],
};

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'json');
  const channels = program.command('channels');
  registerChannelsLogsCommand(channels, program);
  await program.parseAsync(['node', 'hookmyapp', 'channels', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDefaultWorkspaceId.mockResolvedValue('ws_w1');
});

describe('channels logs show', () => {
  it('renders the human detail view for a delivery', async () => {
    mocks.apiClient.mockResolvedValue(DETAIL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'show', 'd1']);

    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('Delivery d1');
    expect(out).toContain('What WhatsApp sent us');
    log.mockRestore();
  });

  it('emits the raw detail body verbatim under --json', async () => {
    mocks.apiClient.mockResolvedValue(DETAIL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'show', 'd1', '--json']);

    expect(log).toHaveBeenCalledWith(JSON.stringify(DETAIL, null, 2));
    log.mockRestore();
  });

  it('fetches detail with the resolved workspace id, no channel', async () => {
    mocks.apiClient.mockResolvedValue(DETAIL);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'show', 'd1']);

    expect(mocks.apiClient).toHaveBeenCalledWith('/deliveries/d1', {
      workspaceId: 'ws_w1',
    });
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('remaps a 404 into a friendly ValidationError', async () => {
    mocks.apiClient.mockRejectedValue(new ApiError('Delivery not found.', 404));

    await expect(run(['logs', 'show', 'missing'])).rejects.toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/channels-logs/show.test.ts`
Expected: FAIL — `channels logs show` is not a registered command, so Commander throws an unknown-command error rather than reaching the assertions.

- [ ] **Step 3: Write the implementation**

In `src/commands/channels-logs/index.ts`, extend the import from `../../output/error.js` and the import from `./api.js`, and add the helper import from `../_helpers.js`:

```typescript
import { ValidationError, ApiError } from '../../output/error.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import {
  fetchDeliveriesPage,
  fetchAllDeliveries,
  fetchDeliveryDetail,
  type DeliveriesPage,
  type FetchDeliveriesParams,
} from './api.js';
import { toListRows, renderDeliveryDetail } from './render.js';
```

Add the `show` action handler (place it after `runChannelLogsList`):

```typescript
async function runChannelLogsShow(
  id: string,
  json: boolean,
  verbose: boolean,
): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  let detail;
  try {
    detail = await fetchDeliveryDetail(id, workspaceId);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      throw new ValidationError(
        `Delivery not found or outside the retention window: ${id}`,
      );
    }
    throw err;
  }

  if (json) {
    output(detail, { json: true });
    return;
  }
  console.log(renderDeliveryDetail(detail, { verbose }));
}
```

Inside `registerChannelsLogsCommand`, register the `show` subcommand (after `logsList`, before the `addExamples` calls):

```typescript
  const logsShow = logs
    .command('show')
    .description('Show the full detail of one delivery')
    .argument('<id>', 'Delivery ID from `channels logs list`')
    .option('--verbose', 'Include request/response headers')
    .action(async (id: string, opts: { verbose?: boolean }) => {
      await runChannelLogsShow(id, !!program.opts().json, !!opts.verbose);
    });
```

Add its `EXAMPLES` block alongside the others:

```typescript
  addExamples(
    logsShow,
    `
EXAMPLES:
  $ hookmyapp channels logs show 9b1f2e3d-4c5a-6789-0abc-def012345678
  $ hookmyapp channels logs show 9b1f2e3d-4c5a-6789-0abc-def012345678 --json
`,
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/channels-logs/show.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-logs/index.ts src/__tests__/channels-logs/show.test.ts
git commit -m "feat(channels-logs): channels logs show command"
```

---

## Task 8: Wire into the `channels` group + docs + full verification

**Files:**
- Modify: `src/commands/channels.ts:10` and `src/commands/channels.ts:244`
- Modify: `README.md`

- [ ] **Step 1: Wire the command into `channels.ts`**

In `src/commands/channels.ts`, add the import directly below the existing `registerChannelsListenCommand` import (line 10):

```typescript
import { registerChannelsListenCommand } from './channels-listen/index.js';
import { registerChannelsLogsCommand } from './channels-logs/index.js';
```

Inside `registerChannelsCommand`, register it immediately after the `registerChannelsListenCommand(channels, program);` call (line 244):

```typescript
  // `hookmyapp channels listen` — spec 2026-05-15.
  registerChannelsListenCommand(channels, program);

  // `hookmyapp channels logs` — spec 2026-05-20. Read-only delivery history,
  // the non-streaming sibling of `channels listen`.
  registerChannelsLogsCommand(channels, program);
```

- [ ] **Step 2: Run the help contract + channels regression tests**

Run: `npx vitest run src/__tests__/help.test.ts src/__tests__/channels.test.ts`
Expected: PASS. `help.test.ts` now walks `channels logs`, `channels logs list`, and `channels logs show`; each has an `EXAMPLES:` block with ≥2 `  $ hookmyapp ` lines (added in Tasks 6–7). `channels.test.ts` is unaffected — no existing channel behavior changed.

If `help.test.ts` fails on one of the new commands, the cause is a missing or single-example `addExamples()` call — fix the relevant block in `src/commands/channels-logs/index.ts`.

- [ ] **Step 3: Update the README command examples**

In `README.md`, find the command-examples block that contains `hookmyapp channels webhook show ch_xxxxxxxx` and `hookmyapp channels listen ch_xxxxxxxx --port 3000`. Add two lines after the `channels listen` line:

```
hookmyapp channels logs list ch_xxxxxxxx
hookmyapp channels logs show <delivery-id>
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — the entire suite, including the 5 new `channels-logs` test files (32 new tests: time 6, api 6, render 10, list 6, show 4) and the unchanged existing suite.

- [ ] **Step 5: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; `node build.mjs` (esbuild) completes. esbuild does not type-check, so `tsc --noEmit` is the real type gate.

- [ ] **Step 6: Smoke-check the help output**

Run: `node bin/hookmyapp.js channels logs --help && node bin/hookmyapp.js channels logs list --help`
Expected: both print usage with the `EXAMPLES:` block. `logs list --help` shows `--limit`, `--since`, `--until`, `--cursor`, `--all`.

- [ ] **Step 7: Commit**

```bash
git add src/commands/channels.ts README.md
git commit -m "feat(channels-logs): register channels logs under the channels group + docs"
```

---

## Self-Review

**Spec coverage:**

- D1 (group with `list`/`show` verbs) → Tasks 6, 7, 8.
- D2 (reuse `GET /deliveries` + `/deliveries/:id`, no backend) → Task 2.
- D3 (`list` channel-scoped, `show` workspace-scoped) → Task 2 (`fetchDeliveriesPage` builds `scope=channel:`; `fetchDeliveryDetail` takes only a workspace id), Task 7 (`show` resolves the workspace via `getDefaultWorkspaceId`, never `resolveChannel`).
- D5 (`--json`: verbatim single-page, aggregate under `--all`) → Task 6 (`output(page, { json: true })`), Task 3 (`fetchAllDeliveries` returns the `{ deliveries, nextCursor, floorHours }` shape; `nextCursor` non-null = capped).
- D6 (`--limit`/`--since`/`--until`/`--cursor`/`--all`, `show --verbose`) → Tasks 1, 6, 7.
- D7 (no status/search filters) → not built; nothing to do.
- D8 (output shapes: list table, three-section detail) → Tasks 4, 5.
- D9 (retention-floor note only when `--since` clamped) → Task 6.
- D10 (errors/exit codes: bad limit/time → `ValidationError`; 404 → friendly `ValidationError`; empty → exit 0 message) → Tasks 6, 7.
- Testing section (mock `apiClient`; assert verbatim vs aggregate JSON) → all 5 test files.

**Placeholder scan:** none — every code step contains complete, ready-to-use content. The only "delete this" instruction (Task 6) was removed; `index.ts` is shown as two clean blocks (handlers, then the registration function).

**Type consistency:** `DeliveriesPage`, `DeliveryListItem`, `DeliveryDetail`, `DeliveryAttempt`, `FetchDeliveriesParams` are defined once in `api.ts` (Task 2) and imported unchanged everywhere. `fetchDeliveriesPage`/`fetchDeliveryDetail`/`fetchAllDeliveries` signatures are stable across Tasks 3, 6, 7. `registerChannelsLogsCommand(channels, program)` has the same two-arg shape in Tasks 6, 7, and 8 — matching `registerChannelsListenCommand`.
