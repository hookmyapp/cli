// src/commands/channels-connect-poll.ts
import { apiClient } from '../api/client.js';
import { parseChannelListItem, type Channel } from '../api/channel.js';
import { CliError } from '../output/error.js';

/**
 * D2 polling acceptance criteria:
 *   1. Caller snapshots existing {channelId -> updatedAt} BEFORE opening OAuth
 *      (race-safe — if the snapshot ran AFTER open(), a fast backend write
 *      could include the new channel in "existing" and never report it).
 *   2. Poll /meta/channels every 2s after browser launch.
 *   3. A channel is "interesting" if:
 *        (a) its id is NOT in the snapshot (truly new — first-time connect /
 *            coexistence pair), OR
 *        (b) its id IS in the snapshot AND its updatedAt advanced past
 *            the snapshot value (re-auth of existing — token rotation
 *            updates the row but creates no new id).
 *      (b) requires the backend to return `updatedAt` on the list DTO.
 *      Older backends omit it; in that case (b) is effectively disabled
 *      and we fall back to id-diff-only (legacy 5min-hang behaviour for
 *      re-auth, which is no worse than before).
 *   4. Exit when: (interesting.length > 0 AND no new interesting in last 4s),
 *      OR 5min hard timeout.
 *   5. Return ALL interesting channels.
 *
 * On Ctrl+C: Node's default behavior terminates the process on unhandled
 * SIGINT, which exits the CLI cleanly. We intentionally do NOT install a
 * custom SIGINT handler.
 *
 * EXPORTED (not just declared) so other modules can import it AND so
 * vi.mock can intercept the import boundary in tests for runChannelsConnect.
 */
export async function pollForNewChannels(
  workspaceId: string,
  snapshot: ReadonlyMap<string, string | undefined>,
): Promise<Channel[]> {
  const POLL_INTERVAL_MS = 2000;
  const STABILITY_WINDOW_MS = 4000;
  const HARD_TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  let lastChangeAt = 0;
  const seen = new Map<string, Channel>();
  while (true) {
    if (Date.now() - start > HARD_TIMEOUT_MS) {
      throw new CliError(
        'No channels appeared within 5 minutes. Did you complete the OAuth flow in your browser?',
        'CONNECT_TIMEOUT',
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
    for (const dto of dtos) {
      const ch = parseChannelListItem(dto);
      if (seen.has(ch.id)) continue;
      const snapUpdatedAt = snapshot.get(ch.id);
      const isNew = !snapshot.has(ch.id);
      const isUpdated =
        snapshot.has(ch.id) &&
        typeof ch.updatedAt === 'string' &&
        typeof snapUpdatedAt === 'string' &&
        ch.updatedAt > snapUpdatedAt;
      if (isNew || isUpdated) {
        seen.set(ch.id, ch);
        lastChangeAt = Date.now();
      }
    }
    if (seen.size > 0 && Date.now() - lastChangeAt >= STABILITY_WINDOW_MS) {
      return Array.from(seen.values());
    }
  }
}
