import type { Command } from 'commander';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { c } from '../output/color.js';
import { renderTable } from '../output/table.js';
import { CliError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { cliCommandPrefix } from '../output/cli-self.js';
import open from 'open';
import { select } from '@inquirer/prompts';
import { pollForNewChannels } from './channels-connect-poll.js';
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

/**
 * Type-aware human-readable label for a Channel, used in success-message
 * output for `channels disconnect/enable/disable` (Task B7). The
 * discriminated-union shape gives the compiler full narrowing.
 *
 *   whatsapp  → "WhatsApp +972…"
 *   instagram → "Instagram @ordvir"
 *   messenger → "Messenger ch_XXXXXXXX"
 */
function channelLabel(c: Channel): string {
  if (c.type === 'whatsapp') return `WhatsApp ${c.displayPhoneNumber ?? c.wabaName ?? c.id}`;
  if (c.type === 'instagram') return `Instagram @${c.instagramUsername ?? c.id}`;
  return `Messenger ${c.id}`;
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

interface ChannelsConnectOpts {
  type?: 'whatsapp' | 'instagram';
}

/**
 * Pure helper: maps a channel type to the per-endpoint OAuth start
 * request shape. The two endpoints have different body requirements
 * (WA needs an allowlisted redirectPath; IG accepts an empty body).
 * Extracted so routing can be unit-tested without invoking the full
 * runChannelsConnect flow (which would also need the browser + polling
 * mocked).
 */
export function buildConnectStartRequest(
  type: 'whatsapp' | 'instagram',
): { path: string; body: string } {
  if (type === 'whatsapp') {
    return {
      path: '/meta/oauth/start',
      body: JSON.stringify({ redirectPath: '/cli/callback' }),
    };
  }
  return {
    path: '/instagram/oauth/start',
    body: JSON.stringify({}),
  };
}

/**
 * Exported helper: drive the Meta OAuth connect flow end-to-end for either
 * WhatsApp or Instagram (Task B6 — type-aware refactor of the legacy
 * WA-only Embedded Signup flow).
 *
 * Called directly by the post-login wizard (src/auth/login.ts) and by the
 * `channels connect [type]` subcommand action below. Never subprocess-spawned.
 */
export async function runChannelsConnect(
  opts: ChannelsConnectOpts = {},
): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY);
  if (!isTty) {
    throw new ValidationError(
      'channels connect requires a TTY (browser launch + OAuth). ' +
        'In CI, call the backend API directly.',
      'CONNECT_REQUIRES_TTY',
    );
  }

  let type = opts.type;
  if (type === undefined) {
    type = await select<'whatsapp' | 'instagram'>({
      message: 'Which channel type?',
      choices: [
        { name: 'WhatsApp', value: 'whatsapp' },
        { name: 'Instagram', value: 'instagram' },
      ],
    });
  }

  // Force a fresh 15-min token right before opening OAuth. Functionally
  // necessary — a stale access token mid-flow surfaces as a confusing
  // "OAuth state mismatch" error after the user completes the browser
  // step. Preserved from the pre-refactor WA-only implementation.
  await forceTokenRefresh();

  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();

  // 1. SNAPSHOT EXISTING CHANNEL IDS BEFORE OPENING THE BROWSER (D2).
  //    Doing this AFTER open() races a fast backend write — the "new"
  //    channel could be included in the snapshot and never reported.
  const initialDtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
  const existingIds = new Set(initialDtos.map(parseChannelListItem).map((c) => c.id));

  // 2. Route to the per-type OAuth start endpoint via the pure helper.
  const { path, body } = buildConnectStartRequest(type);
  const { redirectUrl } = (await apiClient(path, {
    method: 'POST',
    body,
    workspaceId,
  })) as { redirectUrl: string };

  // 3. Open in browser.
  console.log('\nOpening sign-in in browser...\nComplete the flow, then return here.\n');
  await open(redirectUrl);
  console.log('Waiting for channel(s)...');

  // 4. Poll for new channels per D2 acceptance criteria.
  const newChannels = await pollForNewChannels(workspaceId, existingIds);

  // 5. Report all new channels by type (D7 coexistence shape).
  console.log('\n✓ Connected:');
  for (const ch of newChannels) {
    const label =
      ch.type === 'whatsapp'
        ? `  WhatsApp  ${ch.displayPhoneNumber ?? '(no phone)'}  (${ch.id})`
        : ch.type === 'instagram'
          ? `  Instagram @${ch.instagramUsername ?? '(no handle)'}  (${ch.id})`
          : `  Messenger (${ch.id})`;
    console.log(label);
  }
}

/**
 * Exported handler for `hookmyapp channels list` (Task B3).
 *
 * Type-aware human-table render: IG rows show `@handle`, WA rows show
 * `+phone`. Columns are `Type`, `Identifier`, `Channel ID`, `Forwarding`.
 * JSON mode emits the parsed Channel[] verbatim (wire field names preserved
 * for scripts). Bypasses `output(...)` and writes directly to
 * `process.stdout.write` so tests can spy on exact bytes (see
 * `src/__tests__/channels-list-render.test.ts`).
 *
 * Note: the prior inline action filtered `metaConnected !== false` to hide
 * disconnected channels. That filter is intentionally dropped here — the new
 * IG-aware table is the canonical view and shows every channel the workspace
 * has on file. Operators who want to slice by connection status can use
 * `--json | jq`.
 */
export async function runChannelsList(opts: { json?: boolean }): Promise<void> {
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();
  const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
  const channels = dtos.map(parseChannelListItem);
  if (opts.json) {
    process.stdout.write(JSON.stringify(channels, null, 2) + '\n');
    return;
  }
  if (channels.length === 0) {
    console.log(`No channels. Run: ${cliCommandPrefix()} channels connect <whatsapp|instagram>`);
    return;
  }
  // Loop var is `ch` so it doesn't shadow the imported `c` color helper —
  // `c.success('on')` would otherwise type-error against a Channel.
  const rows = channels.map((ch) => ({
    Type: ch.type === 'whatsapp' ? 'WhatsApp' : ch.type === 'instagram' ? 'Instagram' : 'Messenger',
    Identifier:
      ch.type === 'whatsapp'
        ? ch.displayPhoneNumber ?? ch.wabaName ?? ch.id
        : ch.type === 'instagram'
          ? ch.instagramUsername
            ? `@${ch.instagramUsername}`
            : ch.id
          : ch.id,
    'Channel ID': ch.id,
    Forwarding: ch.forwardingEnabled ? c.success('on') : c.dim('off'),
  }));
  process.stdout.write(renderTable(rows) + '\n');
}

/**
 * Exported handler for `hookmyapp channels show <ref>` (Task B4).
 *
 * Type-aware detail render: WA channels print wabaName/+phone/phoneNumberId/
 * qualityRating; IG channels print @handle/display name. Common fields (type,
 * id, forwarding, webhookUrl, businessName) render for both. JSON mode emits
 * the parsed `ChannelDetail` verbatim. Bypasses `output(...)` and writes
 * directly via `process.stdout.write` / `console.log` so tests can spy on
 * exact bytes (mirroring B3's `runChannelsList` style).
 */
export async function runChannelsShow(
  ref: string,
  opts: { json?: boolean },
): Promise<void> {
  const channel = await resolveChannel(ref);
  const detail: ChannelDetail = parseChannelDetail(
    await apiClient(`/meta/channels/${channel.id}`),
  );
  if (opts.json) {
    process.stdout.write(JSON.stringify(detail, null, 2) + '\n');
    return;
  }
  console.log(`Type: ${detail.type}`);
  console.log(`ID: ${detail.id}`);
  if (detail.type === 'whatsapp') {
    console.log(`WABA: ${detail.wabaName ?? '(unnamed)'}`);
    console.log(`Phone: ${detail.displayPhoneNumber ?? '(none)'}`);
    console.log(`Phone Number ID: ${detail.phoneNumberId ?? '(none)'}`);
    console.log(`Quality rating: ${detail.qualityRating ?? '(unknown)'}`);
  } else if (detail.type === 'instagram') {
    console.log(`Instagram: @${detail.instagramUsername ?? '(no handle)'}`);
    console.log(`Display name: ${detail.instagramName ?? '(none)'}`);
  }
  console.log(`Forwarding: ${detail.forwardingEnabled ? 'on' : 'off'}`);
  console.log(`Webhook URL: ${detail.webhookUrl ?? '(uses CLI tunnel)'}`);
  if (detail.businessName) console.log(`Business: ${detail.businessName}`);
}

/**
 * Exported handler for `hookmyapp channels disconnect <ref>` (Task B7).
 *
 * Type-agnostic at the backend layer (the endpoint accepts any channel id);
 * the CLI-side improvement is the type-aware human success line via
 * `channelLabel`. The previous implementation piped the raw backend
 * response through `output()`, which surfaced opaque JSON like
 * `{ enabled: true }`. `--json` mode is intentionally not preserved on these
 * toggles — the success line is the contract.
 */
export async function runChannelsDisconnect(ref: string): Promise<void> {
  const channel = await resolveChannel(ref);
  await apiClient(`/meta/channels/${channel.id}/disconnect`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
  });
  console.log(`✓ Disconnected ${channelLabel(channel)}`);
}

/**
 * Exported handler for `hookmyapp channels enable <ref>` (Task B7).
 * Companion to `runChannelsDisconnect` — same docstring rationale.
 */
export async function runChannelsEnable(ref: string): Promise<void> {
  const channel = await resolveChannel(ref);
  await apiClient(`/meta/channels/${channel.id}/enable`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
  });
  console.log(`✓ Enabled forwarding on ${channelLabel(channel)}`);
}

/**
 * Exported handler for `hookmyapp channels disable <ref>` (Task B7).
 * Companion to `runChannelsDisconnect` — same docstring rationale.
 */
export async function runChannelsDisable(ref: string): Promise<void> {
  const channel = await resolveChannel(ref);
  await apiClient(`/meta/channels/${channel.id}/disable`, {
    method: 'POST',
    workspaceId: channel.workspaceId,
  });
  console.log(`✓ Disabled forwarding on ${channelLabel(channel)}`);
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
      await runChannelsList({ json: !!program.opts().json });
    });

  const channelsShow = channels
    .command('show')
    .description('Show channel details')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelsShow(channelRef, { json: !!program.opts().json });
    });

  const channelsConnect = channels
    .command('connect')
    .description('Connect a channel via Meta OAuth (WhatsApp or Instagram)')
    .argument('[type]', 'Channel type: "whatsapp" or "instagram" (interactive if omitted)')
    .action(async (type: string | undefined) => {
      if (type !== undefined && type !== 'whatsapp' && type !== 'instagram') {
        throw new ValidationError(
          `Invalid type "${type}". Must be "whatsapp" or "instagram".`,
          'INVALID_CONNECT_TYPE',
        );
      }
      await runChannelsConnect({ type });
    });

  const channelsDisconnect = channels
    .command('disconnect')
    .description('Disconnect a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelsDisconnect(channelRef);
    });

  const channelsEnable = channels
    .command('enable')
    .description('Enable forwarding for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelsEnable(channelRef);
    });

  const channelsDisable = channels
    .command('disable')
    .description('Disable forwarding for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or +<phone> or @<username>')
    .action(async (channelRef: string) => {
      await runChannelsDisable(channelRef);
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
