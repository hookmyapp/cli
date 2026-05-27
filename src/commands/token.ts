import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { isJsonMode } from '../output/format.js';
import { resolveChannel } from './channels.js';

/**
 * Canonical handler for `hookmyapp channels token <channel>` (D9). Also
 * invoked by the deprecated top-level `hookmyapp token <channel>` alias.
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
    .action(async function (this: Command, channelRef: string) {
      console.warn(
        '[deprecated] `hookmyapp token` will be removed in a future release. ' +
          'Use: hookmyapp channels token <channel>',
      );
      await runChannelToken(channelRef, this);
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
