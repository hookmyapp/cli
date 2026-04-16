import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';
import { readCredentials } from '../auth/store.js';
import { getEffectiveApiUrl } from '../config/env-profiles.js';

export function registerWebhookCommand(program: Command): void {
  const webhook = program.command('webhook').description('Manage webhook configuration');

  const webhookShow = webhook
    .command('show')
    .description('Show webhook config')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const data = await apiClient(`/webhook-config/${channel.id}`);
      output(data, { json: !!program.opts().json, kind: 'read' });
    });

  const webhookSet = webhook
    .command('set')
    .description('Set webhook URL and verify token')
    .argument('<waba-id>', 'WABA ID')
    .option('--url <url>', 'Webhook URL')
    .option('--verify-token <token>', 'Verify token')
    .action(async (wabaId: string, opts: { url?: string; verifyToken?: string }) => {
      if (!opts.url) {
        throw new ValidationError(
          '--url is required. Example: hookmyapp webhook set --url https://example.com/hook',
        );
      }

      const channel = await resolveChannel(wabaId);
      const payload = { webhookUrl: opts.url, verifyToken: opts.verifyToken ?? undefined };

      // Check if webhook config already exists
      const baseUrl = getEffectiveApiUrl();
      const creds = readCredentials();
      const checkRes = await fetch(`${baseUrl}/webhook-config/${channel.id}`, {
        headers: { Authorization: `Bearer ${creds!.accessToken}` },
      });

      if (checkRes.ok) {
        await apiClient(`/webhook-config/${channel.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiClient('/webhook-config', {
          method: 'POST',
          body: JSON.stringify({ ...payload, channelId: channel.id }),
        });
      }

      const isJson = !!program.opts().json;
      const result: Record<string, string> = { status: 'configured', url: opts.url };
      if (opts.verifyToken) result.verifyToken = opts.verifyToken;

      output(result, {
        json: isJson,
        kind: 'mutation',
        nudge: `Next: hookmyapp env ${wabaId}`,
      });
    });

  addExamples(
    webhook,
    `
EXAMPLES:
  $ hookmyapp webhook show 1234567890
  $ hookmyapp webhook set 1234567890 --url https://example.com/hook
`,
  );

  addExamples(
    webhookShow,
    `
EXAMPLES:
  $ hookmyapp webhook show 1234567890
  $ hookmyapp webhook show 1234567890 --json
`,
  );

  addExamples(
    webhookSet,
    `
EXAMPLES:
  $ hookmyapp webhook set 1234567890 --url https://example.com/hook
  $ hookmyapp webhook set 1234567890 --url https://example.com/hook --verify-token my-secret
`,
  );
}
