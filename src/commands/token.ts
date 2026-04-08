import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { resolveAccount } from './accounts.js';

export function registerTokenCommand(program: Command): void {
  program
    .command('token')
    .description('Reveal access token')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const data = await apiClient(`/meta/accounts/${account.id}/token`);
      process.stdout.write(data.accessToken + '\n');
    });
}
