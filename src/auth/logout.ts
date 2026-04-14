import { Command } from 'commander';
import { deleteCredentials } from './store.js';
import { addExamples } from '../output/help.js';

export function logoutCommand(program: Command): void {
  const logout = program
    .command('logout')
    .description('Remove stored credentials')
    .action(() => {
      deleteCredentials();
      console.log('\n✓ Logged out\n');
    });

  addExamples(
    logout,
    `
EXAMPLES:
  $ hookmyapp logout
  $ hookmyapp logout --json
`,
  );
}
