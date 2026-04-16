import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';

export function registerHealthCommand(program: Command): void {
  const health = program
    .command('health')
    .description('Check channel health')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const result = await apiClient(`/meta/channels/${channel.id}/refresh`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  addExamples(
    health,
    `
EXAMPLES:
  $ hookmyapp health 1234567890
  $ hookmyapp health 1234567890 --json
`,
  );
}
