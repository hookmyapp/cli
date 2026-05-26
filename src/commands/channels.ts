import type { Command } from 'commander';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { output } from '../output/format.js';
import { CliError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import { readCredentials } from '../auth/store.js';
import { getEffectiveApiUrl } from '../config/env-profiles.js';
import open from 'open';
import { registerChannelsListenCommand } from './channels-listen/index.js';
import { registerChannelsLogsCommand } from './channels-logs/index.js';
import { runChannelEnv } from './env.js';
import { runChannelToken } from './token.js';
import { runChannelHealth } from './health.js';
import {
  runChannelWebhookShow,
  runChannelWebhookSet,
  type WebhookSetOptions,
} from './webhook.js';
import {
  parseChannelListItem,
  parseChannelDetail,
  type Channel,
  type ChannelDetail,
} from '../api/channel.js';
import { parseIdentifier } from '../lib/parseIdentifier.js';

export type { Channel, ChannelDetail };

/** Pick only customer-facing fields for CLI display output */
function pickDisplayFields(channel: ChannelDetail | Record<string, unknown>): unknown {
  const { id, workspaceId, qualityRating, ...display } =
    channel as Record<string, unknown> & { qualityRating?: unknown };
  void id;
  void workspaceId;
  const connectionType = (channel as Record<string, unknown>).connectionType;
  if (connectionType !== 'coexistence' && qualityRating) {
    (display as Record<string, unknown>).qualityRating = qualityRating;
  }
  return display;
}

/**
 * Resolve a CLI channel reference (D3 — shape-detected positional) to a parsed
 * Channel. Accepted shapes:
 *   +E164          → WA channel by displayPhoneNumber
 *   @handle        → IG channel by instagramUsername
 *   ch_XXXXXXXX    → exact publicId match
 *
 * Mismatched-family shapes (ssn_X) throw ValidationError with a wrong-family
 * suggestion; unrecognized shapes propagate parseIdentifier's error.
 */
export async function resolveChannel(ref: string): Promise<Channel> {
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();
  const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
  const channels = dtos.map(parseChannelListItem);
  const parsed = parseIdentifier(ref);
  switch (parsed.kind) {
    case 'phone': {
      const needle = parsed.value;
      const match = channels.find(
        (c): c is Channel & { type: 'whatsapp' } =>
          c.type === 'whatsapp' &&
          c.displayPhoneNumber !== null &&
          c.displayPhoneNumber.replace(/[^\d]/g, '') === needle,
      );
      if (match) return match;
      return throwNoMatch(`+${needle}`, channels);
    }
    case 'username': {
      const match = channels.find(
        (c): c is Channel & { type: 'instagram' } =>
          c.type === 'instagram' && c.instagramUsername === parsed.value,
      );
      if (match) return match;
      return throwNoMatch(`@${parsed.value}`, channels);
    }
    case 'channelId': {
      const match = channels.find((c) => c.id === parsed.value);
      if (match) return match;
      return throwNoMatch(parsed.value, channels);
    }
    case 'sessionId': {
      throw new ValidationError(
        `"${ref}" is a sandbox session publicId; channels commands take ch_X. Did you mean a channel?`,
        'WRONG_IDENTIFIER_FAMILY',
      );
    }
  }
}

function throwNoMatch(needle: string, channels: Channel[]): never {
  const available = channels
    .map((c) => {
      if (c.type === 'whatsapp') return c.displayPhoneNumber ?? c.id;
      if (c.type === 'instagram') return c.instagramUsername ? `@${c.instagramUsername}` : c.id;
      return c.id;
    })
    .join(', ');
  const err = new CliError(
    `No channel matches ${needle}. Available: ${available || '(none)'}. ` +
      `Run: ${cliCommandPrefix()} channels list`,
    'CHANNEL_NOT_FOUND',
  );
  err.exitCode = 2;
  throw err;
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

  // Discover the workspace publicId so we can pass X-Workspace-Id to /meta/oauth/start.
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();

  // Server mints OAuth state + PKCE (replaces the previous `state=cli:<jwt>`
  // URL-construction; JWTs no longer ride in the URL — RFC 6750 fix).
  const oauthStart = (await apiClient('/meta/oauth/start', {
    method: 'POST',
    workspaceId,
    body: JSON.stringify({ redirectPath: '/cli/callback' }),
  })) as { state: string; redirectUrl: string; codeChallenge: string };

  // Snapshot existing channels before signup
  const existingChannels = await apiClient('/meta/channels', { workspaceId });
  console.log('\nOpening Embedded Signup in browser...\nComplete the signup, then return here.\n');
  await open(oauthStart.redirectUrl);
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
      const freshCreds = await readCredentials();
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
  console.log(`  channel: ${newChannel.id}`);
  console.log(`  phone:   ${newChannel.displayPhoneNumber}`);
  if (name) console.log(`  name:    ${name}`);

  // Canonical post-signup hints use the nested `channels ...` form (spec D9).
  // The copy-paste commands reference channel.id (ch_xxxxxxxx), NOT
  // metaWabaId, because the resolver's first-match step is the publicId
  // pattern.
  if (!newChannel.webhookUrl) {
    console.log(`\n→ Next, configure your webhook to receive WhatsApp messages.`);
    console.log(`  The webhook URL should be a publicly accessible HTTPS`);
    console.log(`  endpoint that returns 200 OK.\n`);
    console.log(`  ${cliCommandPrefix()} channels webhook set ${newChannel.id} --url <your-webhook-url>\n`);
    console.log(`→ Then get your credentials:`);
    console.log(`  ${cliCommandPrefix()} channels env ${newChannel.id}\n`);
  } else {
    console.log(`\n✓ Webhook configured: ${newChannel.webhookUrl}`);
    console.log(`\n→ Get your credentials:`);
    console.log(`  ${cliCommandPrefix()} channels env ${newChannel.id}\n`);
  }
}

export function registerChannelsCommand(program: Command): void {
  const channels = program.command('channels').description('Manage WhatsApp channels');

  // `hookmyapp channels listen` — spec 2026-05-15. Mounts under the existing
  // plural parent (D10): real-channel CLI tunnel mirroring `sandbox listen`.
  registerChannelsListenCommand(channels, program);

  // `hookmyapp channels logs` — spec 2026-05-20. Read-only delivery history,
  // the non-streaming sibling of `channels listen`.
  registerChannelsLogsCommand(channels, program);

  const channelsList = channels
    .command('list')
    .description('List all channels')
    .action(async () => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
      const allChannels = dtos.map(parseChannelListItem);
      const connectedChannels = allChannels.filter((c) => c.metaConnected !== false);
      const json = !!program.opts().json;
      if (json) {
        // JSON mode: pass through the parsed channel list (preserves
        // wire field names like `id`, `type`, `metaWabaId`) — scripts
        // depend on the wire shape.
        output(connectedChannels, { json: true });
        return;
      }
      // Default human-readable mode (Task 8): explicit column projection with
      // friendly headers. `Channel ID` (publicId, ch_xxxxxxxx) + `type` are the
      // primary columns; `metaWabaId` is intentionally dropped from the table.
      // IG-aware rendering (Task B3) replaces WA-only name/phone with
      // type-appropriate values.
      const rows = connectedChannels.map((c) => ({
        'Channel ID': c.id,
        type: c.type,
        name: c.type === 'whatsapp' ? (c.wabaName ?? '') : '',
        phone: c.type === 'whatsapp' ? (c.displayPhoneNumber ?? '') : '',
        forwarding: c.forwardingEnabled,
        connected: c.metaConnected,
      }));
      output(rows, { human: true });
    });

  const channelsShow = channels
    .command('show')
    .description('Show channel details')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      const channel = await resolveChannel(channelRef);
      const detail = (await apiClient(`/meta/channels/${channel.id}`)) as ChannelDetail;
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
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      const channel = await resolveChannel(channelRef);
      const result = await apiClient(`/meta/channels/${channel.id}/disconnect`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  const channelsEnable = channels
    .command('enable')
    .description('Enable forwarding for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      const channel = await resolveChannel(channelRef);
      const result = await apiClient(`/meta/channels/${channel.id}/enable`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  const channelsDisable = channels
    .command('disable')
    .description('Disable forwarding for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      const channel = await resolveChannel(channelRef);
      const result = await apiClient(`/meta/channels/${channel.id}/disable`, {
        method: 'POST',
        workspaceId: channel.workspaceId,
      });
      output(result, { human: !program.opts().json });
    });

  // ─── Canonical nested commands (D9) ────────────────────────────────────
  // env / token / health / webhook{show|set} live under `channels` as the
  // canonical surface. Top-level forms in env.ts/token.ts/health.ts/webhook.ts
  // are deprecated aliases that delegate to these handlers.

  const channelsEnv = channels
    .command('env')
    .description('Pull env values for a channel and optionally write to .env')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .option(
      '--write [path]',
      'Upsert credentials into a .env file (default ./.env). Replaces existing WHATSAPP_* keys, preserves everything else.',
    )
    .action(async (channelRef: string, options: { write?: string | boolean }) => {
      await runChannelEnv(channelRef, options);
    });

  const channelsToken = channels
    .command('token')
    .description('Reveal access token for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelToken(channelRef);
    });

  const channelsHealth = channels
    .command('health')
    .description('Health check for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelHealth(channelRef, { human: !program.opts().json });
    });

  const channelsWebhook = channels
    .command('webhook')
    .description("Manage a channel's configured webhook URL");

  const channelsWebhookShow = channelsWebhook
    .command('show')
    .description('Show the configured webhook URL for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelWebhookShow(channelRef, { json: !!program.opts().json });
    });

  const channelsWebhookSet = channelsWebhook
    .command('set')
    .description('Set the configured webhook URL for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .option('--url <url>', 'Webhook URL')
    .option('--verify-token <token>', 'Verify token (auto-generated if omitted)')
    .action(async (channelRef: string, opts: WebhookSetOptions) => {
      await runChannelWebhookSet(channelRef, opts, { json: !!program.opts().json });
    });

  addExamples(
    channels,
    `
EXAMPLES:
  $ hookmyapp channels list
  $ hookmyapp channels connect
  $ hookmyapp channels disconnect ch_AAAAAAAA
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
  $ hookmyapp channels show ch_AAAAAAAA
  $ hookmyapp channels show ch_AAAAAAAA --json
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
  $ hookmyapp channels disconnect ch_AAAAAAAA
  $ hookmyapp channels disconnect ch_AAAAAAAA --workspace acme-corp
`,
  );

  addExamples(
    channelsEnable,
    `
EXAMPLES:
  $ hookmyapp channels enable ch_AAAAAAAA
  $ hookmyapp channels enable ch_AAAAAAAA --workspace acme-corp
`,
  );

  addExamples(
    channelsDisable,
    `
EXAMPLES:
  $ hookmyapp channels disable ch_AAAAAAAA
  $ hookmyapp channels disable ch_AAAAAAAA --workspace acme-corp
`,
  );

  addExamples(
    channelsEnv,
    `
EXAMPLES:
  $ hookmyapp channels env ch_AAAAAAAA
  $ hookmyapp channels env ch_AAAAAAAA --write .env
`,
  );

  addExamples(
    channelsToken,
    `
EXAMPLES:
  $ hookmyapp channels token ch_AAAAAAAA
  $ hookmyapp channels token ch_AAAAAAAA --workspace acme-corp
`,
  );

  addExamples(
    channelsHealth,
    `
EXAMPLES:
  $ hookmyapp channels health ch_AAAAAAAA
  $ hookmyapp channels health ch_AAAAAAAA --json
`,
  );

  addExamples(
    channelsWebhook,
    `
EXAMPLES:
  $ hookmyapp channels webhook show ch_AAAAAAAA
  $ hookmyapp channels webhook set ch_AAAAAAAA --url https://example.com/hook
`,
  );

  addExamples(
    channelsWebhookShow,
    `
EXAMPLES:
  $ hookmyapp channels webhook show ch_AAAAAAAA
  $ hookmyapp channels webhook show ch_AAAAAAAA --json
`,
  );

  addExamples(
    channelsWebhookSet,
    `
EXAMPLES:
  $ hookmyapp channels webhook set ch_AAAAAAAA --url https://example.com/hook
  $ hookmyapp channels webhook set ch_AAAAAAAA --url https://example.com/hook --verify-token my-secret
`,
  );
}
