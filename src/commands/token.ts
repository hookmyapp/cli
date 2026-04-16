import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';

export function registerTokenCommand(program: Command): void {
  const token = program
    .command('token')
    .description('Reveal access token')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const data = await apiClient(`/meta/channels/${channel.id}/token`);
      process.stdout.write(data.accessToken + '\n');
    });

  addExamples(
    token,
    `
EXAMPLES:
  $ hookmyapp token 1234567890
  $ hookmyapp token 1234567890 --workspace acme-corp
`,
  );
}
