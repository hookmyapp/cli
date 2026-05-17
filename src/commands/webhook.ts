import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { resolveChannel } from './channels.js';
import { readCredentials } from '../auth/store.js';
import { getEffectiveApiUrl } from '../config/env-profiles.js';

export interface WebhookSetOptions {
  url?: string;
  verifyToken?: string;
}

/**
 * Canonical handler for `hookmyapp channels webhook show <channel>` (D9). Also
 * invoked by the deprecated top-level `hookmyapp webhook show <channel>` alias.
 */
export async function runChannelWebhookShow(
  channelRef: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const channel = await resolveChannel(channelRef);
  const data = await apiClient(`/webhook-config/${channel.id}`);
  output(data, { json: !!opts.json, kind: 'read' });
}

/**
 * Canonical handler for `hookmyapp channels webhook set <channel>` (D9). Also
 * invoked by the deprecated top-level `hookmyapp webhook set <channel>` alias.
 */
export async function runChannelWebhookSet(
  channelRef: string,
  setOpts: WebhookSetOptions,
  outputOpts: { json?: boolean } = {},
): Promise<void> {
  if (!setOpts.url) {
    throw new ValidationError(
      '--url is required. Example: hookmyapp channels webhook set <channel> --url https://example.com/hook',
    );
  }

  const channel = await resolveChannel(channelRef);
  const payload = { webhookUrl: setOpts.url, verifyToken: setOpts.verifyToken ?? undefined };

  // Check if webhook config already exists
  const baseUrl = getEffectiveApiUrl();
  const creds = await readCredentials();
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

  const result: Record<string, string> = { status: 'configured', url: setOpts.url };
  if (setOpts.verifyToken) result.verifyToken = setOpts.verifyToken;

  output(result, {
    json: !!outputOpts.json,
    kind: 'mutation',
    nudge: `Next: hookmyapp channels env ${channel.id}`,
  });
}

/**
 * Deprecated top-level `hookmyapp webhook` alias. Both `show` and `set` emit
 * a stderr deprecation warning and delegate to their canonical handlers.
 * Canonical form is `hookmyapp channels webhook show|set <channel>`.
 */
export function registerWebhookCommand(program: Command): void {
  const webhook = program
    .command('webhook')
    .description('[deprecated] Use `hookmyapp channels webhook ...` instead.');

  const webhookShow = webhook
    .command('show')
    .description('[deprecated] Use `hookmyapp channels webhook show <channel>` instead.')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .action(async (channelRef: string) => {
      console.warn(
        '[deprecated] `hookmyapp webhook show` will be removed in a future release. ' +
          'Use: hookmyapp channels webhook show <channel>',
      );
      await runChannelWebhookShow(channelRef, { json: !!program.opts().json });
    });

  const webhookSet = webhook
    .command('set')
    .description('[deprecated] Use `hookmyapp channels webhook set <channel>` instead.')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .option('--url <url>', 'Webhook URL')
    .option('--verify-token <token>', 'Verify token')
    .action(async (channelRef: string, opts: WebhookSetOptions) => {
      console.warn(
        '[deprecated] `hookmyapp webhook set` will be removed in a future release. ' +
          'Use: hookmyapp channels webhook set <channel>',
      );
      await runChannelWebhookSet(channelRef, opts, { json: !!program.opts().json });
    });

  addExamples(
    webhook,
    `
EXAMPLES:
  $ hookmyapp channels webhook show ch_AAAAAAAA
  $ hookmyapp channels webhook set ch_AAAAAAAA --url https://example.com/hook
`,
  );

  addExamples(
    webhookShow,
    `
EXAMPLES:
  $ hookmyapp channels webhook show ch_AAAAAAAA
  $ hookmyapp channels webhook show ch_AAAAAAAA --json
`,
  );

  addExamples(
    webhookSet,
    `
EXAMPLES:
  $ hookmyapp channels webhook set ch_AAAAAAAA --url https://example.com/hook
  $ hookmyapp channels webhook set ch_AAAAAAAA --url https://example.com/hook --verify-token my-secret
`,
  );
}
