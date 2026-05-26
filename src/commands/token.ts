import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';

/**
 * Canonical handler for `hookmyapp channels token <channel>` (D9). Also
 * invoked by the deprecated top-level `hookmyapp token <channel>` alias.
 */
export async function runChannelToken(channelRef: string): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = await apiClient(`/meta/channels/${channel.id}/token`);
  process.stdout.write(data.accessToken + '\n');
}

/**
 * Deprecated top-level `hookmyapp token` alias. Emits a stderr deprecation
 * warning and delegates to {@link runChannelToken}. Canonical form is
 * `hookmyapp channels token <channel>`.
 */
export function registerTokenCommand(program: Command): void {
  const token = program
    .command('token')
    .description('[deprecated] Use `hookmyapp channels token <channel>` instead.')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      console.warn(
        '[deprecated] `hookmyapp token` will be removed in a future release. ' +
          'Use: hookmyapp channels token <channel>',
      );
      await runChannelToken(channelRef);
    });

  addExamples(
    token,
    `
EXAMPLES:
  $ hookmyapp channels token ch_AAAAAAAA
  $ hookmyapp channels token ch_AAAAAAAA --workspace acme-corp
`,
  );
}
