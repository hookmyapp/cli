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
