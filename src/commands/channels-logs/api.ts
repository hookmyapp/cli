import { apiClient } from '../../api/client.js';
import { readCredentials } from '../../auth/store.js';
import { getEffectiveApiUrl } from '../../config/env-profiles.js';
import { AuthError } from '../../output/error.js';

/** Mirrors backend `WebhookDeliveryOutcome` (@hookmyapp/shared). */
export type DeliveryOutcome = 'delivered' | 'no_response' | 'rejected' | 'skipped';

/** Wire mirror of backend `DeliveryListItem` (deliveries/dto/delivery.response.ts). */
export interface DeliveryListItem {
  id: string;
  receivedAt: string;
  metaMessageId: string | null;
  fromPhone: string | null;
  senderId: string | null;
  senderDisplay: string | null;
  routingDecision: string;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusTooltip: string | null;
  humanStatusColor: 'green' | 'red' | 'gray';
  // Flat outcome columns (replaces the old nested latestAttempt sub-object).
  outcome: DeliveryOutcome;
  forwardStatus: number | null;
  attemptedAt: string | null;
}

/** Wire mirror of backend `RelatedDelivery` — sibling rows sharing a metaMessageId. */
export interface RelatedDelivery {
  id: string;
  receivedAt: string;
  humanStatus: string;
  outcome: DeliveryOutcome;
}

/**
 * Wire mirror of backend `DeliveryDetail` (row-per-request model): each row is
 * exactly one forward, so the forward fields are flat on the DTO rather than a
 * nested `attempts[]` array. `forwardUrl === null` means no destination was
 * configured and no forward was attempted.
 *
 * `senderDisplay` + `senderId` (D8): IG-aware identity, returned by the
 * backend for every delivery regardless of channel type. WA channels get
 * `senderDisplay` mirroring `fromPhone`; IG channels carry the `@handle` +
 * IG scoped ID. Falls back to `fromPhone` in the CLI sender chain.
 *
 * `humanStatusTooltip`: GUI-only field (tooltip text shown on hover in the
 * web UI). Carried on the DTO for shape parity with sandbox/logs.ts; the
 * CLI never renders it and `toLogsJson()` strips it from `--json` output.
 */
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
  senderId: string | null;
  senderDisplay: string | null;
  receivedAt: string;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusTooltip: string | null;
  humanStatusColor: 'green' | 'red' | 'gray';
  // Flat forward fields (replaces the old nested attempts[] array).
  outcome: DeliveryOutcome;
  outcomeReason: string | null;
  forwardUrl: string | null;
  forwardRequestHeaders: Record<string, string> | null;
  forwardRequestBody: string | null;
  forwardStatus: number | null;
  forwardDurationMs: number | null;
  forwardResponseHeaders: Record<string, string> | null;
  forwardResponseBody: string | null;
  forwardResponseBodySha256: string | null;
  forwardResponseBodyTruncated: boolean;
  attemptedAt: string | null;
  relatedDeliveries: RelatedDelivery[];
}

/**
 * JSON-mode projection. `humanStatusTooltip` + `humanStatusColor` are
 * GUI-only (CLI has no tooltips; colors come from picocolors, not the
 * backend hex hint). Stripping them keeps the agent-facing stream lean and
 * avoids implying the backend's color choice is canonical for terminals.
 * Mirrors sandbox/logs.ts `toLogsJson()` byte-for-byte (D8 parity).
 */
export function toLogsJson(
  d: DeliveryDetail,
): Omit<DeliveryDetail, 'humanStatusTooltip' | 'humanStatusColor'> {
  const { humanStatusTooltip: _t, humanStatusColor: _c, ...rest } = d;
  return rest;
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
    // A page that returns zero rows with a non-null cursor would never advance
    // `deliveries.length` — break so `--all` cannot spin on requests forever.
    if (page.deliveries.length === 0) break;
    cursor = page.nextCursor;
  }

  return { deliveries, nextCursor, floorHours };
}

/**
 * SSE async generator for `channels logs list --follow`. Opens a stream to
 * `GET /deliveries/stream?scope=channel:<publicId>`, parses `delivery`
 * events, fetches the full DeliveryDetail per eventId, and yields each one.
 *
 * Mirrors the SSE parsing logic in `src/commands/sandbox/logs.ts` runFollow —
 * the protocol is identical, only the `scope` value differs (channel: vs
 * sandbox-session:). Per the plan's DRY guidance the two functions stay
 * duplicated until a third caller appears, since channel vs sandbox have
 * different scope shapes and per-row render dispatch.
 *
 * Auth: explicit `Authorization: Bearer` + `X-Workspace-Id` header, same as
 * apiClient. Stops on `taken_over` or `closed` events, or when the stream
 * naturally ends.
 */
export async function* streamDeliveries(args: {
  channelPublicId: string;
  workspaceId: string;
}): AsyncIterableIterator<DeliveryDetail> {
  const { channelPublicId, workspaceId } = args;

  const creds = await readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }

  const base = getEffectiveApiUrl().replace(/\/$/, '');
  const scope = `channel:${channelPublicId}`;
  const url = `${base}/deliveries/stream?scope=${encodeURIComponent(scope)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'X-Workspace-Id': workspaceId,
        Accept: 'text/event-stream',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthError(`SSE connect failed: ${msg}`);
  }

  if (!res.ok || !res.body) {
    throw new AuthError(`SSE connect failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seenIds = new Set<string>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are double-newline-delimited.
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trim();
        }
      }

      if (event === 'delivery' && data) {
        try {
          const payload = JSON.parse(data) as { eventId?: string };
          const eventId = payload.eventId;
          if (!eventId || seenIds.has(eventId)) continue;
          seenIds.add(eventId);
          const detail = await fetchDeliveryDetail(eventId, workspaceId);
          yield detail;
        } catch {
          // Skip malformed event or transient fetch error.
        }
      }

      if (event === 'taken_over' || event === 'closed') {
        return;
      }
    }
  }
}
