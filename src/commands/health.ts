import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { resolveAccount } from './accounts.js';

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Check account health')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const result = await apiClient(`/meta/accounts/${account.id}/refresh`, {
        method: 'POST',
        workspaceId: account.workspaceId,
      });
      output(result, { human: program.opts().human });
    });
}
