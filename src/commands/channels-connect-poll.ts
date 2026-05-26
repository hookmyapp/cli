// src/commands/channels-connect-poll.ts
import { apiClient } from '../api/client.js';
import { parseChannelListItem, type Channel } from '../api/channel.js';
import { CliError } from '../output/error.js';

/**
 * D2 polling acceptance criteria:
 *   1. Caller snapshots existing channel ids BEFORE opening OAuth (race-safe).
 *   2. Poll /meta/channels every 2s after browser launch.
 *   3. Track newIds = channels not in the snapshot.
 *   4. Exit when: (a) newIds.length > 0 AND no new id in last 4s (stability), OR
 *      (b) 5min hard timeout.
 *   5. Return ALL new channels.
 *
 * On Ctrl+C: Node's default behavior terminates the process on unhandled
 * SIGINT, which exits the CLI cleanly. We intentionally do NOT install a
 * custom SIGINT handler — the spec mentions SIGINT as an exit condition
 * but the implementation relies on the runtime default rather than an
 * explicit AbortController + signal pump. If we later need a partial
 * summary on Ctrl+C ("here are the channels we saw before you canceled"),
 * add AbortController-based cancellation in a follow-up.
 *
 * The `existingIds` Set MUST be captured BEFORE `open()` in the caller —
 * doing the snapshot inside this helper after the browser launches races a
 * fast backend write where the new channel could be included in the
 * "existing" snapshot and never reported.
 *
 * EXPORTED (not just declared) so other modules can import it AND so
 * vi.mock can intercept the import boundary in tests for runChannelsConnect.
 */
export async function pollForNewChannels(
  workspaceId: string,
  existingIds: ReadonlySet<string>,
): Promise<Channel[]> {
  const POLL_INTERVAL_MS = 2000;
  const STABILITY_WINDOW_MS = 4000;
  const HARD_TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  let lastNewAt = 0;
  const seenNewIds = new Map<string, Channel>();
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
      if (!existingIds.has(ch.id) && !seenNewIds.has(ch.id)) {
        seenNewIds.set(ch.id, ch);
        lastNewAt = Date.now();
      }
    }
    if (seenNewIds.size > 0 && Date.now() - lastNewAt >= STABILITY_WINDOW_MS) {
      return Array.from(seenNewIds.values());
    }
  }
}
