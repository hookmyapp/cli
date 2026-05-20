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

/**
 * Minimal wire-shape mirror of the `/meta/channels` response used by the
 * resolver. Only the fields the resolver actually reads are typed; the
 * permissive index signature keeps it forward-compatible with API additions
 * (resolver doesn't need them, but downstream callers that receive the
 * resolved channel do).
 */
export interface ApiChannel {
  id: string;
  type?: 'whatsapp' | 'instagram' | 'messenger';
  workspaceId: string;
  metaWabaId: string;
  phoneNumberId?: string | null;
  displayPhoneNumber?: string | null;
  wabaName?: string | null;
  forwardingEnabled?: boolean;
  // additional fields exist on the wire but the resolver doesn't need them
  [key: string]: unknown;
}

/** Pick only customer-facing fields for CLI display output */
function pickDisplayFields(channel: any): any {
  const { id, workspaceId, qualityRating, ...display } = channel;
  if (channel.connectionType !== 'coexistence' && qualityRating) {
    display.qualityRating = qualityRating;
  }
  return display;
}

const PUBLIC_ID_PATTERN = /^ch_[a-z0-9]{8}$/i;
const NUMERIC_WABA_PATTERN = /^\d{15,16}$/;

function stripPhone(s: string): string {
  return s.replace(/[\s\-+()]/g, '');
}

/**
 * Thrown when a fuzzy wabaName match returns 2+ candidates in a non-TTY
 * (non-interactive) context. The CLI cannot prompt, so callers must re-run
 * with a more specific reference. The `matches` array lets structured callers
 * (e.g. JSON output, tests) render the alternatives without parsing the
 * message string.
 */
export class AmbiguousChannelError extends CliError {
  public matches: Array<{ id: string; wabaName: string | null | undefined }>;
  constructor(matches: Array<{ id: string; wabaName: string | null | undefined }>) {
    super(
      `Multiple channels match. Use one of:\n` +
        matches.map((m) => `  ${m.id}\t${m.wabaName ?? '(no name)'}`).join('\n'),
      'CHANNEL_AMBIGUOUS',
    );
    this.matches = matches;
    this.exitCode = 2;
  }
}

/**
 * Resolve a user-supplied channel reference to the full channel object.
 *
 * Resolver order (first match wins):
 *   1. publicId pattern (ch_xxxxxxxx) → channel.id
 *   2. exact phoneNumberId
 *   3. exact display phone (raw or stripped E.164)
 *   4. exact wabaName
 *   5. fuzzy wabaName (case-insensitive substring) — single match auto-selects;
 *      2+ matches throw AmbiguousChannelError in non-TTY, else interactive picker
 *   6. /^\d{15,16}$/ → friendly "looks like a Meta WABA ID" hard-break error
 *   7. generic not-found
 */
export async function resolveChannel(ref: string): Promise<ApiChannel> {
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();
  const channels: ApiChannel[] = await apiClient('/meta/channels', { workspaceId });

  // 1. publicId pattern → wire field is `id`
  if (PUBLIC_ID_PATTERN.test(ref)) {
    const match = channels.find((c: ApiChannel) => c.id === ref);
    if (match) return match;
  }

  // 2. exact phone_number_id
  const byPhoneId = channels.find((c: ApiChannel) => c.phoneNumberId === ref);
  if (byPhoneId) return byPhoneId;

  // 3. exact display phone (stripped match)
  const stripped = stripPhone(ref);
  const byPhone = channels.find(
    (c: ApiChannel) => !!c.displayPhoneNumber && stripPhone(c.displayPhoneNumber) === stripped,
  );
  if (byPhone) return byPhone;

  // 4. exact wabaName (the API field; rendered as "channel name" in UI)
  const byNameExact = channels.find((c: ApiChannel) => c.wabaName === ref);
  if (byNameExact) return byNameExact;

  // 5. fuzzy wabaName (case-insensitive substring)
  const fuzzyMatches = channels.filter(
    (c: ApiChannel) =>
      typeof c.wabaName === 'string' &&
      c.wabaName.toLowerCase().includes(ref.toLowerCase()),
  );
  if (fuzzyMatches.length === 1) return fuzzyMatches[0];
  if (fuzzyMatches.length > 1) {
    if (!process.stdout.isTTY) {
      throw new AmbiguousChannelError(
        fuzzyMatches.map((c: ApiChannel) => ({ id: c.id, wabaName: c.wabaName })),
      );
    }
    // Interactive picker — use `selectChannel` (forwarding-agnostic). We MUST
    // NOT use `pickChannel` here because resolveChannel is shared by
    // enable/disable/show/disconnect/env/token/health/webhook — those commands
    // legitimately operate on channels with forwardingEnabled=false (e.g.
    // `channels enable` exists precisely to flip that flag). `pickChannel`'s
    // forwarding-enabled filter is correct for `channels listen` only.
    const { selectChannel } = await import('./channels-listen/picker.js');
    return await selectChannel<ApiChannel>(fuzzyMatches);
  }

  // 6. Looks-like-wabaId hard-break
  if (NUMERIC_WABA_PATTERN.test(ref)) {
    throw new ValidationError(
      `"${ref}" looks like a Meta WABA ID. The CLI now uses channel IDs (ch_xxxxxxxx).\n` +
        `  Run: ${cliCommandPrefix()} channels list\n` +
        `  Then re-run with the channel ID from the output.`,
    );
  }

  // 7. Generic fallback
  throw new ValidationError(
    `channel not found: ${ref}. Run: ${cliCommandPrefix()} channels list`,
  );
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
      const data = await apiClient('/meta/channels', { workspaceId });
      const connectedChannels = data.filter((c: any) => c.metaConnected !== false);
      const json = !!program.opts().json;
      if (json) {
        // JSON mode: pass through the raw API response (incl. `id`, `type`,
        // `metaWabaId`, `phoneNumberId`, …) — scripts depend on the wire shape.
        output(connectedChannels, { json: true });
        return;
      }
      // Default human-readable mode (Task 8): explicit column projection with
      // friendly headers. `Channel ID` (publicId, ch_xxxxxxxx) + `type` are the
      // primary columns; `metaWabaId` is intentionally dropped from the table.
      const rows = connectedChannels.map((c: any) => ({
        'Channel ID': c.id,
        type: c.type ?? '',
        name: c.wabaName ?? '',
        phone: c.displayPhoneNumber ?? '',
        forwarding: c.forwardingEnabled ?? '',
        connected: c.metaConnected ?? '',
      }));
      output(rows, { human: true });
    });

  const channelsShow = channels
    .command('show')
    .description('Show channel details')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .action(async (channelRef: string) => {
      const channel = await resolveChannel(channelRef);
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
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
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
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
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
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
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
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
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
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .action(async (channelRef: string) => {
      await runChannelToken(channelRef);
    });

  const channelsHealth = channels
    .command('health')
    .description('Health check for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .action(async (channelRef: string) => {
      await runChannelHealth(channelRef, { human: !program.opts().json });
    });

  const channelsWebhook = channels
    .command('webhook')
    .description("Manage a channel's configured webhook URL");

  const channelsWebhookShow = channelsWebhook
    .command('show')
    .description('Show the configured webhook URL for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .action(async (channelRef: string) => {
      await runChannelWebhookShow(channelRef, { json: !!program.opts().json });
    });

  const channelsWebhookSet = channelsWebhook
    .command('set')
    .description('Set the configured webhook URL for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
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
