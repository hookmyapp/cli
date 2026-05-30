import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { resolveChannel } from './channels.js';

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
  const result = await apiClient(`/meta/channels/${channel.id}/refresh`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
  });
  output(result, { human: opts.human !== false });
}
