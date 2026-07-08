import { apiClient } from '../../api/client.js';
import { readCredentials } from '../../auth/store.js';
import { getEffectiveApiUrl } from '../../config/env-profiles.js';
import { AuthError } from '../../output/error.js';

export type DeliveryStatus =
  | 'delivered'
  | 'no_response'
  | 'rejected'
  | 'not_delivered'
  | 'skipped';

export type DeliveryDestination =
  | { type: 'webhook'; url: string }
  | { type: 'cli'; label: 'CLI listener' }
  | null;

export interface DeliveryLog {
  /** wd_ public id — the handle `channels logs show <id>` takes. */
  publicId: string;
  receivedAt: string;
  sender: string | null;
  messageId: string | null;
  meta: unknown;
  hookmyapp: {
    status: DeliveryStatus;
    statusText: string;
    destination: DeliveryDestination;
    appResponse: {
      status: number | null;
      durationMs: number | null;
      body: unknown;
    };
  };
}

/** Wire mirror of the backend `GET /deliveries` list response. */
export interface DeliveriesPage {
  logs: DeliveryLog[];
  nextCursor: string | null;
}

export function cleanDeliveryLog(log: DeliveryLog): DeliveryLog {
  const destination = log.hookmyapp.destination;
  return {
    publicId: log.publicId,
    receivedAt: log.receivedAt,
    sender: log.sender,
    messageId: log.messageId,
    meta: log.meta,
    hookmyapp: {
      status: log.hookmyapp.status,
      statusText: log.hookmyapp.statusText,
      destination:
        destination === null
          ? null
          : destination.type === 'cli'
            ? { type: 'cli', label: 'CLI listener' }
            : { type: 'webhook', url: destination.url },
      appResponse: {
        status: log.hookmyapp.appResponse.status,
        durationMs: log.hookmyapp.appResponse.durationMs,
        body: log.hookmyapp.appResponse.body,
      },
    },
  };
}

function cleanDeliveriesPage(page: DeliveriesPage): DeliveriesPage {
  return {
    logs: page.logs.map(cleanDeliveryLog),
    nextCursor: page.nextCursor,
  };
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
  return cleanDeliveriesPage((await apiClient(`/deliveries?${query.toString()}`, {
    workspaceId: params.workspaceId,
  })) as DeliveriesPage);
}

/**
 * Fetch one delivery's full detail from `GET /deliveries/:id`. The detail
 * endpoint is workspace-scoped (spec D3) — it resolves a delivery by id within
 * the workspace, so there is no channel argument.
 */
export async function fetchDeliveryDetail(
  id: string,
  workspaceId: string,
): Promise<DeliveryLog> {
  return cleanDeliveryLog((await apiClient(`/deliveries/${encodeURIComponent(id)}`, {
    workspaceId,
  })) as DeliveryLog);
}

/** Hard cap on rows collected by `--all`, so a misfire cannot run away. */
export const ALL_ROW_CAP = 1000;

/**
 * Auto-paginate `GET /deliveries` by following `nextCursor` until the result
 * set is exhausted or `ALL_ROW_CAP` rows are collected. The per-request limit
 * is clamped against the remaining cap so the total never overshoots, which
 * keeps the last page boundary exact: the returned `nextCursor` is non-null
 * iff rows remain beyond the cap (spec D5 — that is the truncation signal).
 */
export async function fetchAllDeliveries(
  params: FetchDeliveriesParams,
): Promise<DeliveriesPage> {
  const logs: DeliveryLog[] = [];
  let cursor: string | undefined = params.cursor;
  let nextCursor: string | null = null;

  while (logs.length < ALL_ROW_CAP) {
    const pageLimit = Math.min(params.limit, ALL_ROW_CAP - logs.length);
    const page = await fetchDeliveriesPage({ ...params, limit: pageLimit, cursor });
    logs.push(...page.logs);
    nextCursor = page.nextCursor;
    if (!page.nextCursor) break;
    // A page that returns zero rows with a non-null cursor would never advance
    // `logs.length` — break so `--all` cannot spin on requests forever.
    if (page.logs.length === 0) break;
    cursor = page.nextCursor;
  }

  return { logs, nextCursor };
}

/**
 * SSE async generator for `channels logs list --follow`. Opens a stream to
 * `GET /deliveries/stream?scope=channel:<publicId>`, parses `delivery`
 * events, fetches the public delivery log per eventId, and yields each one.
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
}): AsyncIterableIterator<DeliveryLog> {
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
          const payload = JSON.parse(data) as { eventId?: string; publicId?: string };
          const eventId = payload.eventId ?? payload.publicId;
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
