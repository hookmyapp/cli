// src/commands/channels-connect-poll.ts
import { apiClient } from '../api/client.js';
import { parseChannelListItem, type Channel } from '../api/channel.js';

/**
 * D2 polling acceptance criteria (AIT-334 revision — no hard timeout):
 *   1. Caller snapshots existing {channelId -> metaConnected} BEFORE opening
 *      OAuth (race-safe — if the snapshot ran AFTER open(), a fast backend
 *      write could include the new channel in "existing" and never report it).
 *   2. Poll /meta/channels every 2s after browser launch.
 *   3. A channel is "interesting" if:
 *        (a) its id is NOT in the snapshot (truly new — first-time connect /
 *            coexistence pair), OR
 *        (b) its id IS in the snapshot, it was disconnected then, and it is
 *            connected now (reconnect of that channel).
 *      AIT-775: an existing channel's updatedAt is NOT a signal. Background
 *      jobs (profile/follower refresh, health checks) bump it constantly, so
 *      any routine write to ANY channel ended the wait with a false
 *      "Connected". Re-auth of an already-connected channel is therefore not
 *      detected; the caller prints a note telling the user to Ctrl+C then.
 *   4. Exit when: interesting.length > 0 AND no new interesting in last 4s.
 *      There is NO hard timeout — a real Meta OAuth (login + 2FA +
 *      permission screens) routinely exceeds 5 minutes, and the old
 *      5-min CONNECT_TIMEOUT reported failure to users whose connect
 *      then succeeded (Sentry HOOKMYAPP-CLI-15). Ctrl+C is the only
 *      way out; `onStillWaiting` fires every 30s so the wait is
 *      visibly alive.
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
  snapshot: ReadonlyMap<string, boolean>,
  onStillWaiting?: (elapsedMs: number) => void,
): Promise<Channel[]> {
  const POLL_INTERVAL_MS = 2000;
  const STABILITY_WINDOW_MS = 4000;
  const STILL_WAITING_INTERVAL_MS = 30_000;
  const start = Date.now();
  let lastChangeAt = 0;
  let lastHintAt = start;
  const seen = new Map<string, Channel>();
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
    for (const dto of dtos) {
      const ch = parseChannelListItem(dto);
      if (seen.has(ch.id)) continue;
      const isNew = !snapshot.has(ch.id);
      const isReconnected = snapshot.get(ch.id) === false && ch.metaConnected;
      if (isNew || isReconnected) {
        seen.set(ch.id, ch);
        lastChangeAt = Date.now();
      }
    }
    if (seen.size > 0 && Date.now() - lastChangeAt >= STABILITY_WINDOW_MS) {
      return Array.from(seen.values());
    }
    if (seen.size === 0 && Date.now() - lastHintAt >= STILL_WAITING_INTERVAL_MS) {
      lastHintAt = Date.now();
      onStillWaiting?.(Date.now() - start);
    }
  }
}
