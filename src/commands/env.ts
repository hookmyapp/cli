import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { resolveAccount } from './accounts.js';

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Output credentials as .env format')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const tokenData = await apiClient(`/meta/accounts/${account.id}/token`);

      process.stdout.write(
        `WABA_ID=${account.metaWabaId}\nACCESS_TOKEN=${tokenData.accessToken}\nPHONE_NUMBER_ID=${account.phoneNumberId}\n`,
      );
    });

  addExamples(
    env,
    `
EXAMPLES:
  $ hookmyapp env 1234567890
  $ hookmyapp env 1234567890 > .env
`,
  );
}
