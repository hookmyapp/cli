import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';

/** Backend wire-shape for `GET /meta/channels/:publicId/token` (gateway model). */
interface TokenSummary {
  hasActiveKey: boolean;
  keyPrefix: string;
  keySuffix: string;
}

/**
 * Canonical handler for `hookmyapp channels token <channel>`.
 *
 * DEPRECATED surface — the real Meta token is no longer exposed by HookMyApp
 * (gateway model). This command now only summarises gateway-key presence:
 * `GET /meta/channels/:id/token` returns `{ hasActiveKey, keyPrefix, keySuffix }`.
 * To obtain a USABLE key, run `hookmyapp keys create <channel>`.
 *
 * Human mode prints a one-line key-presence summary. `--json` emits
 * `{ channelId, type, hasActiveKey, keyPrefix, keySuffix }`.
 */
export async function runChannelToken(channelRef: string, cmd?: Command): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = (await apiClient(`/meta/channels/${channel.id}/token`)) as TokenSummary;

  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(
      JSON.stringify({
        channelId: channel.id,
        type: channel.type,
        hasActiveKey: data.hasActiveKey,
        keyPrefix: data.keyPrefix,
        keySuffix: data.keySuffix,
      }) + '\n',
    );
    return;
  }

  if (!data.hasActiveKey) {
    process.stdout.write(
      `no key present — run "hookmyapp keys create ${channelRef}" to mint a usable key\n`,
    );
    return;
  }

  process.stdout.write(
    `key present: ${data.keyPrefix}…${data.keySuffix} — run "hookmyapp keys create ${channelRef}" for a new usable key\n`,
  );
}
