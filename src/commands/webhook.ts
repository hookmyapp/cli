import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { CliError } from '../output/error.js';
import { resolveAccount } from './accounts.js';
import { readCredentials } from '../auth/store.js';

export function registerWebhookCommand(program: Command): void {
  const webhook = program.command('webhook').description('Manage webhook configuration');

  webhook
    .command('show')
    .description('Show webhook config')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const account = await resolveAccount(wabaId);
      const data = await apiClient(`/webhook-config/${account.id}`);
      output(data, { human: program.opts().human });
    });

  webhook
    .command('set')
    .description('Set webhook URL and verify token')
    .argument('<waba-id>', 'WABA ID')
    .option('--url <url>', 'Webhook URL')
    .option('--verify-token <token>', 'Verify token')
    .action(async (wabaId: string, opts: { url?: string; verifyToken?: string }) => {
      if (!opts.url) {
        throw new CliError('--url flag is required', 'VALIDATION_ERROR');
      }

      const account = await resolveAccount(wabaId);
      const payload = { webhookUrl: opts.url, verifyToken: opts.verifyToken ?? undefined };

      // Check if webhook config already exists
      const baseUrl = process.env.HOOKMYAPP_API_URL ?? 'https://uninked-robbi-boughless.ngrok-free.dev';
      const creds = readCredentials();
      const checkRes = await fetch(`${baseUrl}/webhook-config/${account.id}`, {
        headers: { Authorization: `Bearer ${creds!.accessToken}` },
      });

      if (checkRes.ok) {
        await apiClient(`/webhook-config/${account.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiClient('/webhook-config', {
          method: 'POST',
          body: JSON.stringify({ ...payload, accountId: account.id }),
        });
      }

      console.log(`\n✓ Webhook configured`);
      console.log(`  url:   ${opts.url}`);
      if (opts.verifyToken) console.log(`  token: ${opts.verifyToken}`);
      console.log(`\n→ Get your credentials:`);
      console.log(`  hookmyapp env ${wabaId}\n`);
    });
}
