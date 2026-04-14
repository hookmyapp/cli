// Cloudflared subprocess + heartbeat + graceful-shutdown machinery for
// `hookmyapp sandbox listen`. See RESEARCH §Pattern 5 (lines 470-506).
//
// CRITICAL pitfalls addressed here:
//   §Pitfall 1  — NO `--url` flag on spawn. Token-mode tunnels are "remotely
//                 managed" and pull ingress config from the CF /configurations
//                 endpoint (written by the backend in /tunnel/configure).
//                 cloudflared silently ignores --url in token mode, so adding
//                 it here only masks bugs where configure wasn't called.
//   §Pitfall 10 — Set TUNNEL_ORIGIN_CERT=/dev/null on the child env. Otherwise
//                 cloudflared will auto-pick up any `cert.pem` in the user's
//                 ~/.cloudflared/ dir and silently switch to named-tunnel
//                 cert-auth, breaking our token-mode flow.

import { spawn, ChildProcess } from 'node:child_process';
import { apiClient } from '../../api/client.js';

// Exported so gracefulShutdown can flip it before sending SIGTERM. Once true,
// cloudflared's stderr filter stops writing — otherwise every Ctrl-C surfaces
// ~16 "ERR Connection terminated" / "context canceled" / "no more connections
// active" lines that are just the closure log.
let shuttingDown = false;
export function markShuttingDown(): void {
  shuttingDown = true;
}

// Shutdown-noise pattern — cloudflared logs each connection closure as ERR.
// These are strictly expected during normal Ctrl-C and MUST stay hidden.
const SHUTDOWN_NOISE =
  /context canceled|Connection terminated|no more connections active|accept stream listener encountered a failure while serving|control stream encountered a failure while serving|failed to run the datagram handler|Serve tunnel error|failed to serve tunnel connection|Application error 0x0 \(remote\)/;

export function spawnCloudflared(opts: {
  binaryPath: string;
  token: string;
}): ChildProcess {
  // Pitfall 1 (NO --url): args are intentionally token-only.
  // NOTE: --no-autoupdate and --loglevel are GLOBAL flags that MUST come BEFORE
  // the `tunnel` subcommand. Putting them after `tunnel run` makes cloudflared
  // exit immediately with "flag provided but not defined" — an error format the
  // stderr filter below does not match, so it fails silently.
  const args = [
    '--no-autoupdate',
    '--loglevel',
    'warn',
    'tunnel',
    'run',
    '--token',
    opts.token,
  ];

  const child = spawn(opts.binaryPath, args, {
    env: {
      ...process.env,
      // Pitfall 10: block origin-cert auto-pickup.
      TUNNEL_ORIGIN_CERT: '/dev/null',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Filter cloudflared's chatty stderr — surface structured ERR/WRN lines AND
  // any "Incorrect Usage" / "flag provided but not defined" / "error:" lines
  // that cloudflared emits when invoked with bad flags (those skip the
  // structured log format and would otherwise be silently dropped).
  //
  // During graceful shutdown (shuttingDown=true), suppress ALL further stderr —
  // cloudflared emits a stream of "ERR Connection terminated" / "context
  // canceled" / "no more connections active" lines that are purely closure
  // noise and not actionable for the user.
  child.stderr?.on('data', (buf: Buffer) => {
    if (shuttingDown) return;
    const text = buf.toString();
    for (const line of text.split('\n')) {
      if (SHUTDOWN_NOISE.test(line)) continue;
      if (
        /\bERR\b|\bWRN\b/.test(line) ||
        /Incorrect Usage|flag provided but not defined|error:/i.test(line)
      ) {
        process.stderr.write(line + '\n');
      }
    }
  });

  // Also surface if cloudflared exits non-zero — otherwise the process dies and
  // sandbox listen hangs on heartbeats with no visible failure. Suppress during
  // graceful shutdown (SIGTERM from us → expected non-zero exit).
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code !== null && code !== 0) {
      process.stderr.write(
        `cloudflared exited with code ${code}${signal ? ` (signal ${signal})` : ''}\n`,
      );
    }
  });

  return child;
}

export interface HeartbeatHandle {
  stop: () => void;
}

/**
 * Ping /sandbox/sessions/:id/tunnel/heartbeat on a fixed interval.
 * Tolerates a single transient failure: on the first error, we log and keep
 * going; on the SECOND consecutive error, we call onError (parent may use
 * that to abort with a user-facing message).
 */
export function startHeartbeat(opts: {
  sessionId: string;
  workspaceId: string;
  intervalMs?: number;
  onError: (err: Error) => void;
}): HeartbeatHandle {
  const interval = opts.intervalMs ?? 30_000;
  let consecutiveFailures = 0;

  const timer = setInterval(() => {
    apiClient(`/sandbox/sessions/${opts.sessionId}/tunnel/heartbeat`, {
      method: 'POST',
      workspaceId: opts.workspaceId,
    })
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((err: Error) => {
        consecutiveFailures += 1;
        if (consecutiveFailures === 1) {
          // Log but don't panic — single blips are normal.
          process.stderr.write(`heartbeat: transient failure (${err.message})\n`);
          return;
        }
        if (consecutiveFailures === 2) {
          opts.onError(err);
        }
      });
  }, interval);

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

export interface GracefulShutdownArgs {
  cloudflaredChild: ChildProcess;
  proxyClose: () => Promise<void>;
  stopHeartbeat: () => void;
  callBackendStop: () => Promise<void>;
}

/**
 * Shutdown order (CONTEXT.md §CLI Flow Step 11):
 *   stopHeartbeat() → proxyClose() → callBackendStop() → child.kill('SIGTERM')
 *   wait up to 5s for child exit, then SIGKILL.
 *
 * Backend stop is best-effort — wrapped in try/catch so a flaky backend
 * doesn't leave the user stuck in the terminal.
 */
export async function gracefulShutdown(args: GracefulShutdownArgs): Promise<void> {
  // Flip before any teardown — silences cloudflared's closure-noise stderr
  // (context canceled, Connection terminated, no more connections active, etc.)
  // which would otherwise spam ~16 ERR lines on every Ctrl-C.
  markShuttingDown();

  args.stopHeartbeat();
  try {
    await args.proxyClose();
  } catch {
    // swallow — we're tearing down anyway
  }
  try {
    await args.callBackendStop();
  } catch {
    // don't block exit on backend failure
  }
  args.cloudflaredChild.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      args.cloudflaredChild.kill('SIGKILL');
      resolve();
    }, 5_000);
    args.cloudflaredChild.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
