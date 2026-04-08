import { Command } from 'commander';
import { deleteCredentials } from './store.js';

export function logoutCommand(program: Command): void {
  program
    .command('logout')
    .description('Remove stored credentials')
    .action(() => {
      deleteCredentials();
      console.log('\n✓ Logged out\n');
    });
}
