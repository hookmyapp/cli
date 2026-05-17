import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';

/**
 * Canonical handler for `hookmyapp channels health <channel>` (D9). Also
 * invoked by the deprecated top-level `hookmyapp health <channel>` alias.
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

/**
 * Deprecated top-level `hookmyapp health` alias. Emits a stderr deprecation
 * warning and delegates to {@link runChannelHealth}. Canonical form is
 * `hookmyapp channels health <channel>`.
 */
export function registerHealthCommand(program: Command): void {
  const health = program
    .command('health')
    .description('[deprecated] Use `hookmyapp channels health <channel>` instead.')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .action(async (channelRef: string) => {
      console.warn(
        '[deprecated] `hookmyapp health` will be removed in a future release. ' +
          'Use: hookmyapp channels health <channel>',
      );
      await runChannelHealth(channelRef, { human: !program.opts().json });
    });

  addExamples(
    health,
    `
EXAMPLES:
  $ hookmyapp channels health ch_AAAAAAAA
  $ hookmyapp channels health ch_AAAAAAAA --json
`,
  );
}
