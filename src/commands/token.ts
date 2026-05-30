import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';

/**
 * Canonical handler for `hookmyapp channels token <channel>`.
 *
 * Human mode emits the raw access token to stdout (preserved for
 * shell-piping). `--json` mode wraps the result as
 * `{channelId, type, accessToken}` so agents can parse the response and
 * verify they received the right token (D6 — cli-cleanup spec).
 */
export async function runChannelToken(channelRef: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = await apiClient(`/meta/channels/${channel.id}/token`);
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(
      JSON.stringify({
        channelId: channel.id,
        type: channel.type,
        accessToken: data.accessToken,
      }) + '\n',
    );
    return;
  }
  process.stdout.write(data.accessToken + '\n');
}
