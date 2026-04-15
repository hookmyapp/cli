// `hookmyapp sandbox listen` — Commander subcommand wiring the 11-step flow
// from 107-CONTEXT.md §CLI Flow. Composes the Plan 09a modules (binary,
// proxy-server, summarizer, version-check) with Plan 09b's picker + lifecycle.
//
// Exit code contract (CONTEXT.md §CLI Flow Exit codes):
//   0  clean
//   1  not authenticated
//   2  no active sessions / --phone|--session mismatch
//   3  tunnel provisioning failed (backend /tunnel/start or /configure)
//   4  cloudflared download/checksum failed
//   5  backend unreachable

import type { Command } from 'commander';
import { apiClient } from '../../api/client.js';
import { CliError, AuthError, ConflictError } from '../../output/error.js';
import { resolveEnv } from '../../config/env-profiles.js';
import { addExamples } from '../../output/help.js';
import { cliCommandPrefix } from '../../output/cli-self.js';
import { readCredentials } from '../../auth/store.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { ensureCloudflaredBinary } from './binary.js';
import { startProxyServer, type LogLine } from './proxy-server.js';
import { pickSession, type Session } from './picker.js';
import {
  spawnCloudflared,
  startHeartbeat,
  gracefulShutdown,
} from './lifecycle.js';
import { checkForNewerCli } from './version-check.js';

export interface ListenOpts {
  port: number;
  path: string;
  phone?: string;
  session?: string;
  verbose: boolean;
  json: boolean;
  reinstallTunnelBinary: boolean;
}

export interface TunnelStartResponse {
  cloudflareTunnelToken: string;
  hostname: string;
  webhookPath?: string;
}

/**
 * Execute the sandbox-listen flow against an already-resolved session.
 *
 * The wizard (src/auth/login.ts runSandboxFlow) has already picked or created
 * the session, so this entry point skips Steps 1-5 (auth gate, version check,
 * session picker) and drives Steps 6-11 directly. Imported by the wizard via
 * a direct function call — never subprocess spawn.
 */
export async function runSandboxListenFlow(
  session: Session,
  opts: Partial<ListenOpts> = {},
): Promise<void> {
  const human = !opts.json;
  const listenOpts: ListenOpts = {
    port: opts.port ?? 3000,
    path: opts.path ?? '/webhook',
    phone: opts.phone,
    session: opts.session,
    verbose: opts.verbose ?? false,
    json: opts.json ?? false,
    reinstallTunnelBinary: opts.reinstallTunnelBinary ?? false,
  };

  // Step 3 — ensure cloudflared binary (exit 4 on download/checksum failure).
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

  // Step 6 — start tunnel. The backend already returns enforcement-matrix
  // copy verbatim (phase-108 plan 03) for 409 LISTENER_ACTIVE_SAME /
  // LISTENER_ACTIVE / PHONE_TAKEN_ANOTHER — let those propagate as
  // ConflictError (exit 6) so users see the remediation text. Non-conflict
  // provisioning failures (5xx, timeouts) still map to exit 3.
  const env = resolveEnv();
  let tunnel: TunnelStartResponse;
  try {
    tunnel = (await apiClient(
      `/sandbox/sessions/${session.id}/tunnel/start`,
      {
        method: 'POST',
        body: JSON.stringify({ env }),
        workspaceId: session.workspaceId,
      },
    )) as TunnelStartResponse;
  } catch (err) {
    if (err instanceof ConflictError || err instanceof AuthError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Tunnel provisioning failed: ${msg}`);
    process.exit(3);
  }

  // Step 7 — bind local proxy; configure ingress; spawn cloudflared.
  const proxy = await startProxyServer({
    upstreamPort: listenOpts.port,
    upstreamPath: listenOpts.path,
    onRequest: (line) => printLogLine(line, listenOpts),
  });

  try {
    await apiClient(
      `/sandbox/sessions/${session.id}/tunnel/configure`,
      {
        method: 'POST',
        body: JSON.stringify({ originPort: proxy.port }),
        workspaceId: session.workspaceId,
      },
    );
  } catch (err) {
    await proxy.close();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Tunnel configure failed: ${msg}`);
    process.exit(3);
  }

  const child = spawnCloudflared({
    binaryPath,
    token: tunnel.cloudflareTunnelToken,
  });

  // Step 8 — ready banner.
  printBanner({
    hostname: tunnel.hostname,
    localPort: listenOpts.port,
    path: listenOpts.path,
    session,
    json: listenOpts.json,
  });

  // Step 9 — heartbeat loop.
  const hb = startHeartbeat({
    sessionId: session.id,
    workspaceId: session.workspaceId,
    intervalMs: 30_000,
    onError: (err) => {
      process.stderr.write(
        `heartbeat: repeated failures (${err.message}) — tunnel may be reconciled\n`,
      );
    },
  });

  // Step 11 — SIGINT/SIGTERM handlers.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (human) {
      process.stderr.write('\nShutting down…\n');
    }
    await gracefulShutdown({
      cloudflaredChild: child,
      proxyClose: () => proxy.close(),
      stopHeartbeat: hb.stop,
      callBackendStop: () =>
        apiClient(
          `/sandbox/sessions/${session.id}/tunnel/stop`,
          { method: 'POST', workspaceId: session.workspaceId },
        ).then(() => undefined).catch(() => undefined),
    });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function registerListenCommand(sandbox: Command, program: Command): void {
  const listen = sandbox
    .command('listen')
    .description(
      'Start a sandbox tunnel and stream incoming webhooks to your local app',
    )
    .option(
      '--port <n>',
      'Local port your app listens on',
      (v: string) => parseInt(v, 10),
      3000,
    )
    .option('--path <p>', 'Webhook path on your app', '/webhook')
    .option('--phone <e164>', 'Skip session picker by test phone')
    .option('--session <id>', 'Skip session picker by session id')
    .option('--verbose', 'Print full request/response bodies', false)
    .option('--json', 'Machine-readable event log', false)
    .option(
      '--reinstall-tunnel-binary',
      'Force re-download of cloudflared',
      false,
    )
    .action(async (opts: ListenOpts) => {
      const human = !program.opts().json && !opts.json;

      // Step 1 — auth gate. Throw AuthError so main() maps it to exit 4
      // (auth-required) rather than a blanket exit 1 that masks the real
      // condition from CI scripts.
      if (!readCredentials()) {
        throw new AuthError(`Not logged in. Run: ${cliCommandPrefix()} login`);
      }

      // Step 2 — version nudge (non-blocking, silent-on-error per 09a).
      await checkForNewerCli();

      // Step 4 — fetch active sessions. apiClient's own mapApiError already
      // produces typed subclasses (AuthError/NetworkError/ConflictError/...)
      // with the correct exit codes — let them propagate to main().
      const workspaceId = await getDefaultWorkspaceId();
      const sessions = (await apiClient('/sandbox/sessions?active=true', {
        method: 'GET',
        workspaceId,
      })) as Session[];

      // Step 5 — pick. pickSession throws CliError (exit 2) for
      // NO_ACTIVE_SESSIONS / SESSION_MISMATCH — let main() format + exit.
      const chosen = await pickSession({
        sessions,
        phoneFlag: opts.phone,
        sessionFlag: opts.session,
        isHuman: human,
      });

      // Ensure the session carries the correct workspaceId (listen picker
      // sessions come from a workspace-scoped list, but the type allows null).
      const sessionWithWorkspace: Session = {
        ...chosen,
        workspaceId: chosen.workspaceId ?? workspaceId,
      };

      // Steps 3 + 6-11: cloudflared binary, tunnel provision, local proxy,
      // banner, heartbeat, signal handlers. Shared with the post-login wizard.
      await runSandboxListenFlow(sessionWithWorkspace, opts);
    });

  addExamples(
    listen,
    `
EXAMPLES:
  $ hookmyapp sandbox listen
  $ hookmyapp sandbox listen --phone +15551234567 --port 3000
  $ hookmyapp sandbox listen --path /webhook --verbose
`,
  );
}

function printLogLine(line: LogLine, opts: ListenOpts): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(line) + '\n');
    return;
  }
  process.stdout.write(
    `${line.ts}  ${line.method} ${line.path}  →  ${line.status}  (${line.ms}ms)   ${line.summary}\n`,
  );
}

function printBanner(args: {
  hostname: string;
  localPort: number;
  path: string;
  session: Session;
  json: boolean;
}): void {
  if (args.json) return;
  const workspace = args.session.workspaceName ?? args.session.workspaceId;
  process.stdout.write(`\n✓ Tunnel active:    https://${args.hostname}\n`);
  process.stdout.write(
    `✓ Forwarding to:    http://localhost:${args.localPort}${args.path}\n`,
  );
  process.stdout.write(
    `  Test phone: ${args.session.phone ?? '(no phone)'} · Workspace: ${workspace}\n`,
  );
  process.stdout.write(`  Press Ctrl-C to stop.\n\n`);
}
