import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';

/** Backend wire-shape for `GET /meta/channels/:publicId/token` (gateway model). */
interface TokenSummary {
  hasActiveToken: boolean;
  tokenPrefix: string;
  tokenSuffix: string;
}

/**
 * Canonical handler for `hookmyapp channels token <channel>`.
 *
 * DEPRECATED surface — the real Meta token is no longer exposed by HookMyApp
 * (gateway model). This command now only summarises gateway access-token presence:
 * `GET /meta/channels/:id/token` returns `{ hasActiveToken, tokenPrefix, tokenSuffix }`.
 * To obtain a USABLE token, run `hookmyapp access-tokens create <channel>`.
 *
 * Human mode prints a one-line key-presence summary. `--json` emits
 * `{ channelId, type, hasActiveToken, tokenPrefix, tokenSuffix }`.
 */
export async function runChannelToken(channelRef: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = (await apiClient(`/meta/channels/${channel.id}/token`)) as TokenSummary;

  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(
      JSON.stringify({
        channelId: channel.id,
        type: channel.type,
        hasActiveToken: data.hasActiveToken,
        tokenPrefix: data.tokenPrefix,
        tokenSuffix: data.tokenSuffix,
      }) + '\n',
    );
    return;
  }

  if (!data.hasActiveToken) {
    process.stdout.write(
      `no access token present — run "hookmyapp access-tokens create ${channelRef}" to mint a usable token\n`,
    );
    return;
  }

  process.stdout.write(
    `access token present: ${data.tokenPrefix}…${data.tokenSuffix} — run "hookmyapp access-tokens create ${channelRef}" for a new usable token\n`,
  );
}
