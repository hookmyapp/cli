import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { resolveChannel, channelLabel } from './channels.js';

export interface WebhookSetOptions {
  url?: string;
  verifyToken?: string;
}

/**
 * Canonical handler for `hookmyapp channels webhook show <channel>`.
 */
export async function runChannelWebhookShow(
  channelRef: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = await apiClient(`/webhook-config/${channel.id}`);
  output(data, { json: !!opts.json, kind: 'read' });
}

/**
 * Canonical handler for `hookmyapp channels webhook set <channel>`.
 */
export async function runChannelWebhookSet(
  channelRef: string,
  setOpts: WebhookSetOptions,
  outputOpts: { json?: boolean } = {},
): Promise<void> {
  if (!setOpts.url) {
    throw new ValidationError(
      '--url is required. Example: hookmyapp channels webhook set <channel> --url https://example.com/hook',
    );
  }

  const channel = await resolveChannel(channelRef);
  const payload = { webhookUrl: setOpts.url, verifyToken: setOpts.verifyToken ?? undefined };

  // Check whether a webhook config already exists. Route through apiClient (not
  // a raw fetch) so workspace/version headers, 426 handling, token refresh, and
  // typed error mapping all apply. ONLY a 404 means "absent" → create; any
  // other failure (403/500/network) must surface as a typed error rather than
  // silently falling through to a POST (which would be the wrong mutation).
  let exists = true;
  try {
    await apiClient(`/webhook-config/${channel.id}`, { method: 'GET' });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      exists = false;
    } else {
      throw err;
    }
  }

  if (exists) {
    await apiClient(`/webhook-config/${channel.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  } else {
    await apiClient('/webhook-config', {
      method: 'POST',
      body: JSON.stringify({ ...payload, channelId: channel.id }),
    });
  }

  const result: Record<string, string> = { status: 'configured', url: setOpts.url };
  if (setOpts.verifyToken) result.verifyToken = setOpts.verifyToken;

  output(result, {
    json: !!outputOpts.json,
    kind: 'mutation',
    nudge: `Next: hookmyapp channels env ${channel.id}`,
  });

  if (!outputOpts.json) {
    console.log(`✓ Webhook URL set for ${channelLabel(channel)}`);
  }
}

/**
 * Canonical handler for `hookmyapp channels webhook clear <channel>`.
 * Reverts the channel to the HookMyApp CLI default destination by clearing the
 * configured webhook URL (DELETE /webhook-config/:channelId). Idempotent: a
 * no-op 204 when no URL is set, so it is safe to run unconditionally.
 */
export async function runChannelWebhookClear(
  channelRef: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  await apiClient(`/webhook-config/${channel.id}`, { method: 'DELETE' });
  output({ status: 'cleared' }, { json: !!opts.json, kind: 'mutation' });
  if (!opts.json) {
    console.log(
      `✓ Webhook URL cleared for ${channelLabel(channel)} (now uses CLI tunnel)`,
    );
  }
}
