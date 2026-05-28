// `hookmyapp channels listen` — real-channel mirror of `sandbox listen`.
//
// Spec: docs/superpowers/specs/2026-05-15-cli-channel-listen-design.md
// Plan: docs/superpowers/plans/2026-05-15-cli-channel-listen-cli.md
//
// Shares the binary, proxy-server, summarizer, version-check, and
// graceful-shutdown machinery with sandbox-listen — what's different is the
// picker (real channels with forwardingEnabled=true), the endpoints
// (/channels/:id/tunnel/{start,configure,heartbeat,stop}), and the heartbeat
// loop's recognition of `410 CHANNEL_TUNNEL_RECLAIMED` as a terminal status
// (spec D3).

import type { Command } from 'commander';
import { apiClient } from '../../api/client.js';
import {
  AuthError,
  CliError,
  ConflictError,
} from '../../output/error.js';
import { addExamples } from '../../output/help.js';
import { cliCommandPrefix } from '../../output/cli-self.js';
import { readCredentials } from '../../auth/store.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { ensureCloudflaredBinary } from '../sandbox-listen/binary.js';
import { startProxyServer, type LogLine } from '../sandbox-listen/proxy-server.js';
import { spawnCloudflared, gracefulShutdown } from '../sandbox-listen/lifecycle.js';
import { checkForNewerCli } from '../sandbox-listen/version-check.js';
import { emit, getCliVersion } from '../../observability/posthog.js';
import { pickChannel, type Channel } from './picker.js';
import { startChannelHeartbeat } from './lifecycle.js';

export interface ChannelListenOpts {
  port: number;
  path: string;
  verbose: boolean;
  json: boolean;
  reinstallTunnelBinary: boolean;
}

export interface ChannelTunnelStartResponse {
  cloudflareTunnelToken: string;
  hostname: string;
  webhookPath?: string;
}

/**
 * Execute the channels-listen flow against an already-resolved channel.
 *
 * Imported by the wizard (src/auth/login.ts runWizardFlow) via direct
 * function call when the user picks "Listen on a real channel". Mirrors
 * runSandboxListenFlow's split between the wizard-callable entry and the
 * commander action handler (which prepends auth + version-check + picker).
 */
export async function runChannelListenFlow(
  channel: Channel,
  opts: Partial<ChannelListenOpts> = {},
): Promise<void> {
  const listenOpts: ChannelListenOpts = {
    port: opts.port ?? 3000,
    path: opts.path ?? '/webhook',
    verbose: opts.verbose ?? false,
    json: opts.json ?? false,
    reinstallTunnelBinary: opts.reinstallTunnelBinary ?? false,
  };
  const human = !listenOpts.json;

  // Cloudflared binary — same exit-4-on-failure contract as sandbox-listen.
  let binaryPath: string;
  try {
    binaryPath = await ensureCloudflaredBinary({
      force: listenOpts.reinstallTunnelBinary,
    });
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`cloudflared: ${err.userMessage}`);
      process.exit(4);
    }
    throw err;
  }

  // /tunnel/start — empty body per backend DTO (TunnelStartDto has no fields;
  // idempotency lives in the service's "active tunnel for this channel?"
  // check). Test escape hatch HOOKMYAPP_E2E_FAKE_TUNNEL=1 short-circuits to
  // a synthetic response so integration tests don't mint real CF resources.
  const fakeTunnel = process.env.HOOKMYAPP_E2E_FAKE_TUNNEL === '1';
  let tunnel: ChannelTunnelStartResponse;
  if (fakeTunnel) {
    tunnel = {
      cloudflareTunnelToken: 'fake-e2e-token',
      hostname: 'fake-e2e.hookmyapp-listen.com',
      webhookPath: '/webhook',
    };
  } else {
    try {
      tunnel = (await apiClient(`/channels/${channel.id}/tunnel/start`, {
        method: 'POST',
        body: JSON.stringify({}),
        workspaceId: channel.workspaceId,
      })) as ChannelTunnelStartResponse;
    } catch (err) {
      if (err instanceof ConflictError || err instanceof AuthError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Tunnel provisioning failed: ${msg}`);
      process.exit(3);
    }
  }

  // Local proxy server before /tunnel/configure — backend needs the bound
  // local port to write the CF tunnel's ingress rule.
  const proxy = await startProxyServer({
    upstreamPort: listenOpts.port,
    upstreamPath: listenOpts.path,
    onRequest: (line) => printLogLine(line, listenOpts),
  });

  if (!fakeTunnel) {
    try {
      // Backend TunnelConfigureDto: { port: number }. Note this differs from
      // sandbox's `{ originPort }` — channel-tunnel was written with the
      // simpler name.
      await apiClient(`/channels/${channel.id}/tunnel/configure`, {
        method: 'POST',
        body: JSON.stringify({ port: proxy.port }),
        workspaceId: channel.workspaceId,
      });
    } catch (err) {
      await proxy.close();
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Tunnel configure failed: ${msg}`);
      process.exit(3);
    }
  }

  const child = spawnCloudflared({
    binaryPath,
    token: tunnel.cloudflareTunnelToken,
  });

  printBanner({
    hostname: tunnel.hostname,
    localPort: listenOpts.port,
    path: listenOpts.path,
    channel,
    json: listenOpts.json,
  });

  const listenStartedAt = Date.now();
  void emit('cli_channel_listen_started', {
    cli_version: getCliVersion(),
    channel_public_id: channel.id,
    workspace_public_id: channel.workspaceId,
  });

  // 2h liveness backstop — covers unclean exits (kill -9, OOM, laptop sleep)
  // that don't fire `_stopped`. Inline rather than a shared helper because
  // the sandbox liveness is sandbox-specific (uses session_public_id).
  const livenessTimer = setInterval(() => {
    void emit('cli_channel_listen_liveness', {
      cli_version: getCliVersion(),
      channel_public_id: channel.id,
      elapsed_seconds: Math.floor((Date.now() - listenStartedAt) / 1000),
    });
  }, 2 * 60 * 60 * 1000);

  let shuttingDown = false;

  const hb = startChannelHeartbeat({
    channelId: channel.id,
    workspaceId: channel.workspaceId,
    intervalMs: 30_000,
    onError: (err) => {
      process.stderr.write(
        `heartbeat: repeated failures (${err.message}); tunnel may be reconciled\n`,
      );
    },
    onTerminal: ({ userMessage }) => {
      // 410 CHANNEL_TUNNEL_RECLAIMED — user set a URL or row was reaped.
      // Print the userMessage, run graceful shutdown, exit 0.
      if (human) {
        process.stderr.write(`\n${userMessage}\n`);
      }
      void runShutdown('reclaimed').then(() => process.exit(0));
    },
  });

  const runShutdown = async (reason: 'signal' | 'reclaimed'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (human && reason === 'signal') {
      process.stderr.write('\nShutting down…\n');
    }
    clearInterval(livenessTimer);
    await gracefulShutdown({
      cloudflaredChild: child,
      proxyClose: () => proxy.close(),
      stopHeartbeat: hb.stop,
      // No PostHog liveness helper here — we own livenessTimer inline above.
      callBackendStop: () =>
        fakeTunnel
          ? Promise.resolve()
          : apiClient(`/channels/${channel.id}/tunnel/stop`, {
              method: 'POST',
              workspaceId: channel.workspaceId,
            })
              .then(() => undefined)
              .catch(() => undefined),
    });
  };

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      void emit('cli_channel_listen_stopped', {
        cli_version: getCliVersion(),
        channel_public_id: channel.id,
        duration_seconds: Math.floor((Date.now() - listenStartedAt) / 1000),
      });
      void runShutdown('signal').then(() => resolve());
    };
    const onChildExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (shuttingDown) return;
      process.stderr.write(
        `cloudflared exited unexpectedly (code=${code ?? 'null'}` +
          `${signal ? `, signal=${signal}` : ''}); shutting down listen.\n`,
      );
      void runShutdown('signal').then(() => {
        process.exit(7);
      });
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.once('exit', onChildExit);
  });
}

export function registerChannelsListenCommand(
  channels: Command,
  program: Command,
): void {
  const listen = channels
    .command('listen')
    .description(
      'Start a Cloudflare tunnel for a real channel and stream inbound webhooks to localhost',
    )
    .option(
      '--port <n>',
      'Local port your app listens on',
      (v: string) => parseInt(v, 10),
      3000,
    )
    .option('--path <p>', 'Webhook path on your app', '/webhook')
    .argument(
      '[channel]',
      'Channel: ch_xxxxxxxx, +<phone>, or @<username>. If omitted, an interactive picker is shown.',
    )
    .option('--verbose', 'Print full request/response bodies', false)
    .option('--json', 'Machine-readable event log', false)
    .option(
      '--reinstall-tunnel-binary',
      'Force re-download of cloudflared',
      false,
    )
    .action(async (channelRef: string | undefined, opts: ChannelListenOpts) => {
      const human = !program.opts().json && !opts.json;

      // Positional shape validation is delegated to resolveChannel ->
      // parseIdentifier (which throws IDENTIFIER_UNRECOGNIZED_SHAPE with a
      // helpful suggestion). The legacy `isValidPublicId(channelRef, 'ch')`
      // gate would reject the newly-accepted +phone / @handle shapes.

      if (!(await readCredentials())) {
        throw new AuthError(`Not logged in. Run: ${cliCommandPrefix()} login`);
      }

      await checkForNewerCli();

      // Dynamic imports of channels.js and api/channel.js avoid a static
      // circular import: channels.ts statically imports
      // registerChannelsListenCommand from this file. Static `import { … }
      // from '../channels.js'` here would close the loop. The dynamic
      // `await import(...)` defers evaluation until the action fires (well
      // after both modules are constructed), breaking the cycle without
      // sacrificing the type-aware error message or shape-detected
      // positional resolution.
      let chosen: Channel;
      if (channelRef !== undefined) {
        // Positional: shape-detected resolveChannel handles +phone, @handle,
        // and ch_X. Surfaces a clearer message than the picker's bare
        // CHANNEL_MISMATCH when forwarding is off.
        const { resolveChannel, channelLabel } = await import('../channels.js');
        chosen = await resolveChannel(channelRef);
        if (!chosen.forwardingEnabled) {
          throw new CliError(
            `Channel ${channelLabel(chosen)} has forwarding disabled. ` +
              `Run: ${cliCommandPrefix()} channels enable ${channelRef}`,
            'CHANNEL_FORWARDING_DISABLED',
          );
        }
      } else {
        // No positional: parse the whole list and run the interactive picker.
        const workspaceId = await getDefaultWorkspaceId();
        const { parseChannelListItem } = await import('../../api/channel.js');
        const dtos = (await apiClient('/meta/channels', {
          method: 'GET',
          workspaceId,
        })) as unknown[];
        const allChannels = dtos.map(parseChannelListItem);
        chosen = await pickChannel(allChannels);
      }

      // parseChannelListItem makes workspaceId required on the parsed
      // shape, and resolveChannel returns that same parsed Channel — the
      // legacy `chosen.workspaceId ?? workspaceId` fallback is now dead.
      // Silence unused-var lint without compromising the human/json banner
      // intent (the banner uses `human` indirectly through json flag).
      void human;

      await runChannelListenFlow(chosen, opts);
    });

  addExamples(
    listen,
    `
EXAMPLES:
  $ hookmyapp channels listen                          # interactive picker (no arg)
  $ hookmyapp channels listen ch_AAAAAAAA --port 3000
  $ hookmyapp channels listen --path /webhook --verbose
  $ nohup hookmyapp channels listen --port 3000 &     # background / 24-7
`,
  );
}

function printLogLine(line: LogLine, opts: ChannelListenOpts): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(line) + '\n');
    return;
  }
  process.stdout.write(
    `${line.ts}  ${line.method} ${line.path}  →  ${line.status}  (${line.ms}ms)   ${line.summary}\n`,
  );
}

export function printBanner(args: {
  hostname: string;
  localPort: number;
  path: string;
  channel: Channel;
  json: boolean;
}): void {
  if (args.json) return;
  const subjectLabel =
    args.channel.type === 'whatsapp'
      ? `WhatsApp ${args.channel.displayPhoneNumber ?? args.channel.wabaName ?? args.channel.id}`
      : args.channel.type === 'instagram'
        ? `Instagram @${args.channel.instagramUsername ?? '(no handle)'}`
        : `Messenger ${args.channel.id}`;
  process.stdout.write(`\n✓ Tunnel active:    https://${args.hostname}\n`);
  process.stdout.write(
    `✓ Forwarding to:    http://localhost:${args.localPort}${args.path}\n`,
  );
  process.stdout.write(
    `📋 Logs UI:         http://localhost:${args.localPort}/logs\n`,
  );
  process.stdout.write(`  Channel: ${subjectLabel}\n`);
  process.stdout.write(`  Press Ctrl-C to stop.\n\n`);
}
