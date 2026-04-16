import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('Output credentials as .env format')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const tokenData = await apiClient(`/meta/channels/${channel.id}/token`);

      process.stdout.write(
        `WABA_ID=${channel.metaWabaId}\nACCESS_TOKEN=${tokenData.accessToken}\nPHONE_NUMBER_ID=${channel.phoneNumberId}\n`,
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
