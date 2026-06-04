import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';

/** Backend wire-shape for `GET /meta/channels/:publicId/token` (gateway model). */
interface TokenSummary {
  token: string;
  tokenPrefix: string;
  tokenSuffix: string;
}

/**
 * Canonical handler for `hookmyapp channels token <channel>`.
 *
 * Prints the channel's HookMyApp gateway access token (`hmat_…`) — the bearer
 * the customer sends to the gateway in place of the real Meta token. Every
 * connected channel is born with its access token, so one always exists and is
 * returned in FULL: it is the customer's to read any time (an access token, not
 * a write-once API key). The real upstream Meta token is never exposed.
 *
 * Human mode prints the token. `--json` emits
 * `{ channelId, type, token, tokenPrefix, tokenSuffix }`.
 */
export async function runChannelToken(channelRef: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = (await apiClient(`/meta/channels/${channel.id}/token`)) as TokenSummary;

  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(
      JSON.stringify({
        channelId: channel.id,
        type: channel.type,
        token: data.token,
        tokenPrefix: data.tokenPrefix,
        tokenSuffix: data.tokenSuffix,
      }) + '\n',
    );
    return;
  }

  process.stdout.write(data.token + '\n');
}
