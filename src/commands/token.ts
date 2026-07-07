import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';

/** Backend wire-shape for `GET /meta/channels/:publicId/token`. */
interface TokenSummary {
  token: string;
  tokenPrefix: string;
  tokenSuffix: string;
}

/**
 * Canonical handler for `hookmyapp channels token <channel> [--rotate]`.
 *
 * Prints the channel token (`hmat_...`) used for message sends. Every
 * connected channel is born with its token, so one always exists and is
 * returned in full.
 *
 * With `--rotate`, the current token is revoked and a fresh one is minted
 * atomically (`POST /meta/channels/:id/token/rotate`); the NEW token is then
 * printed. The old token stops working immediately. Without it, the existing
 * token is read (`GET /meta/channels/:id/token`).
 *
 * Human mode prints the (new) token. `--json` emits
 * `{ channelId, type, token, tokenPrefix, tokenSuffix }` identically on both
 * paths.
 */
export async function runChannelToken(
  channelRef: string,
  cmd?: Command,
  rotate = false,
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = (
    rotate
      ? await apiClient(`/meta/channels/${channel.id}/token/rotate`, { method: 'POST' })
      : await apiClient(`/meta/channels/${channel.id}/token`)
  ) as TokenSummary;

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
