import type { Command } from 'commander';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { output } from '../output/format.js';
import { AuthError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import { readCredentials } from '../auth/store.js';
import { getEffectiveApiUrl, getEffectiveAppUrl } from '../config/env-profiles.js';
import open from 'open';

async function fetchAppConfig(): Promise<{ metaAppId: string; metaConfigId: string }> {
  return apiClient('/config');
}

/** Pick only customer-facing fields for CLI display output */
function pickDisplayFields(channel: any): any {
  const { id, workspaceId, qualityRating, ...display } = channel;
  if (channel.connectionType !== 'coexistence' && qualityRating) {
    display.qualityRating = qualityRating;
  }
  return display;
}

/** Resolve a WABA ID to the full channel object with workspaceId */
export async function resolveChannel(wabaId: string): Promise<any> {
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();
  const channels = await apiClient('/meta/channels', { workspaceId });
  const channel = channels.find((c: any) => c.metaWabaId === wabaId);
  if (!channel) {
    throw new ValidationError(`channel not found for WABA ID ${wabaId}`);
  }
  return channel;
}

/**
 * Exported helper: drive the Embedded Signup flow end-to-end.
 *
 * Called directly by the post-login wizard (src/auth/login.ts) and by the
 * `channels connect` subcommand action below. Never subprocess-spawned.
 */
export async function runChannelsConnect(): Promise<void> {
  // Force a fresh 15-min token right before opening signup
  await forceTokenRefresh();
  const creds = readCredentials();
  if (!creds?.accessToken) {
    throw new AuthError(`Not logged in. Run: ${cliCommandPrefix()} login`);
  }

  const config = await fetchAppConfig();
  const appUrl = getEffectiveAppUrl();
  const redirectUri = `${appUrl}/cli/callback`;

  const extras = JSON.stringify({
    featureType: 'whatsapp_business_app_onboarding',
    sessionInfoVersion: '3',
    version: 'v4',
  });

  const u = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  u.searchParams.set('client_id', config.metaAppId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('config_id', config.metaConfigId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('override_default_response_type', 'true');
  u.searchParams.set('extras', extras);
  u.searchParams.set('state', `cli:${creds.accessToken}`);

  // Snapshot existing channels before signup
  const existingChannels = await apiClient('/meta/channels');
  console.log('\nOpening Embedded Signup in browser...\nComplete the signup, then return here.\n');
  await open(u.toString());
  console.log('Waiting for channel...');

  // Poll for new channel (check every 5s, timeout after 15 min)
  const maxWait = 15 * 60 * 1000;
  const pollInterval = 5000;
  const start = Date.now();
  let newChannel: any = null;
  const baseUrl = getEffectiveApiUrl();

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));
    try {
      await forceTokenRefresh();
      const freshCreds = readCredentials();
      if (!freshCreds) continue;

      const res = await fetch(`${baseUrl}/meta/channels`, {
        headers: { Authorization: `Bearer ${freshCreds.accessToken}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) continue;

      const current = await res.json();
      newChannel = current.find((c: any) =>
        !existingChannels.some((e: any) => e.id === c.id)
      );
      if (newChannel) break;
    } catch {
      // Network error — keep trying
    }
  }

  if (!newChannel) {
    console.log(`\nTimed out waiting for channel.\nRun "${cliCommandPrefix()} channels list" to check.\n`);
    return;
  }

  const name = newChannel.phoneVerifiedName ?? newChannel.wabaName ?? '';
  console.log(`\n✓ Channel connected`);
  console.log(`  waba:  ${newChannel.metaWabaId}`);
  console.log(`  phone: ${newChannel.displayPhoneNumber}`);
  if (name) console.log(`  name:  ${name}`);

  // Check if webhook is configured
  if (!newChannel.webhookUrl) {
    console.log(`\n→ Next, configure your webhook to receive WhatsApp messages.`);
    console.log(`  The webhook URL should be a publicly accessible HTTPS`);
    console.log(`  endpoint that returns 200 OK.\n`);
    console.log(`  ${cliCommandPrefix()} webhook set ${newChannel.metaWabaId} --url <your-webhook-url>\n`);
    console.log(`→ Then get your credentials:`);
    console.log(`  ${cliCommandPrefix()} env ${newChannel.metaWabaId}\n`);
  } else {
    console.log(`\n✓ Webhook configured: ${newChannel.webhookUrl}`);
    console.log(`\n→ Get your credentials:`);
    console.log(`  ${cliCommandPrefix()} env ${newChannel.metaWabaId}\n`);
  }
}

export function registerChannelsCommand(program: Command): void {
  const channels = program.command('channels').description('Manage WhatsApp channels');

  const channelsList = channels
    .command('list')
    .description('List all channels')
    .action(async () => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const data = await apiClient('/meta/channels', { workspaceId });
      const connectedChannels = data.filter((c: any) => c.metaConnected !== false);
      output(connectedChannels.map(pickDisplayFields), { human: !program.opts().json });
    });

  const channelsShow = channels
    .command('show')
    .description('Show channel details')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const detail = await apiClient(`/meta/channels/${channel.id}`);
      output(pickDisplayFields(detail), { human: !program.opts().json });
    });

  const channelsConnect = channels
    .command('connect')
    .description('Connect a WhatsApp channel via Embedded Signup')
    .action(async () => {
      await runChannelsConnect();
    });

  const channelsDisconnect = channels
    .command('disconnect')
    .description('Disconnect a channel')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const result = await apiClient(`/meta/channels/${channel.id}/disconnect`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  const channelsEnable = channels
    .command('enable')
    .description('Enable forwarding for a channel')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const result = await apiClient(`/meta/channels/${channel.id}/enable`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  const channelsDisable = channels
    .command('disable')
    .description('Disable forwarding for a channel')
    .argument('<waba-id>', 'WABA ID')
    .action(async (wabaId: string) => {
      const channel = await resolveChannel(wabaId);
      const result = await apiClient(`/meta/channels/${channel.id}/disable`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  addExamples(
    channels,
    `
EXAMPLES:
  $ hookmyapp channels list
  $ hookmyapp channels connect
  $ hookmyapp channels disconnect 1234567890
`,
  );

  addExamples(
    channelsList,
    `
EXAMPLES:
  $ hookmyapp channels list
  $ hookmyapp channels list --json
`,
  );

  addExamples(
    channelsShow,
    `
EXAMPLES:
  $ hookmyapp channels show 1234567890
  $ hookmyapp channels show 1234567890 --json
`,
  );

  addExamples(
    channelsConnect,
    `
EXAMPLES:
  $ hookmyapp channels connect
  $ hookmyapp channels connect --workspace acme-corp
`,
  );

  addExamples(
    channelsDisconnect,
    `
EXAMPLES:
  $ hookmyapp channels disconnect 1234567890
  $ hookmyapp channels disconnect 1234567890 --workspace acme-corp
`,
  );

  addExamples(
    channelsEnable,
    `
EXAMPLES:
  $ hookmyapp channels enable 1234567890
  $ hookmyapp channels enable 1234567890 --workspace acme-corp
`,
  );

  addExamples(
    channelsDisable,
    `
EXAMPLES:
  $ hookmyapp channels disable 1234567890
  $ hookmyapp channels disable 1234567890 --workspace acme-corp
`,
  );
}
