import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { resolveChannel } from './channels.js';

/**
 * Positive allowlist of the customer-facing health fields.
 * `consecutiveForwardFailures` is KEPT — it is the customer's own channel
 * health (the app surfaces it as "your webhook endpoint has failed N times"),
 * which is exactly what a `health` command is for. What's dropped is the one
 * genuinely-internal field the backend refresh result carries:
 * `whatsappQualityRatingCheckedAt` (a cron bookkeeping timestamp, HookMyApp
 * plumbing). Shape, don't spread — same rule the delivery-log cleanup used.
 */
function cleanHealth(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.deleted === true) {
    return { status: 'not_connected', detail: 'Channel is no longer connected at Meta.' };
  }
  const keep = [
    'metaConnected',
    'forwardingEnabled',
    'connectionType',
    'whatsappWabaName',
    'whatsappBusinessName',
    'businessId',
    'whatsappVerifiedName',
    'whatsappQualityRating',
    'consecutiveForwardFailures',
    'tokenExpiresAt',
    'instagramUsername',
    'instagramProfileName',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

/**
 * Canonical handler for `hookmyapp channels health <channel>`.
 *
 * `human` flips JSON output off when callers pass false; default true.
 */
export async function runChannelHealth(
  channelRef: string,
  opts: { human?: boolean } = {},
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const result = (await apiClient(`/meta/channels/${channel.id}/refresh`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
  })) as Record<string, unknown>;
  output(cleanHealth(result), { human: opts.human !== false });
}
