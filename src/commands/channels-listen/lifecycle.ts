// Channel-tunnel heartbeat for `hookmyapp channels listen`.
//
// Parallel of sandbox-listen's `startHeartbeat` (src/commands/sandbox-listen/lifecycle.ts:148),
// adapted for the channel-tunnel endpoint AND the new terminal 410 status.
//
// Why parallel instead of parameterized: sandbox heartbeat has no terminal-status
// concept — sandbox sessions can't be reclaimed mid-listen. Extending sandbox's
// loop with optional terminal handling would couple two semantics that diverge
// elsewhere (spec D3). The two loops share the same transient-failure shape but
// nothing about the failure-recovery semantics; keeping them parallel is the
// cleaner factoring per the spec.

import { apiClient } from '../../api/client.js';

export interface HeartbeatHandle {
  stop: () => void;
}

export interface ChannelTerminalSignal {
  /** Backend AppError.code if available (e.g. 'CHANNEL_TUNNEL_RECLAIMED'). */
  code: string;
  /** Safe-to-print copy from AppError.userMessage. */
  userMessage: string;
}

export interface StartChannelHeartbeatOpts {
  channelId: string;
  workspaceId: string;
  intervalMs?: number;
  /** Called on the SECOND consecutive transient failure (matches sandbox parity). */
  onError: (err: Error) => void;
  /**
   * Called when the backend signals a terminal status (currently only
   * `410 CHANNEL_TUNNEL_RECLAIMED`, per spec D3). After this fires, the
   * loop self-stops — callers should perform graceful shutdown and exit 0.
   */
  onTerminal: (signal: ChannelTerminalSignal) => void;
}

/**
 * Ping /channels/:id/tunnel/heartbeat on a fixed interval.
 *
 * Three error regimes:
 *   - Transient 5xx / network blip: tolerate one (sandbox parity); on the
 *     2nd consecutive failure, invoke `onError` so the parent can decide to
 *     abort or persist.
 *   - 410 (CHANNEL_TUNNEL_RECLAIMED): the backend signals "this tunnel has
 *     been reclaimed — a dashboard URL was set, the row was reaped, or an
 *     explicit Stop call landed." Invoke `onTerminal` once, stop the loop.
 *     Callers exit 0 with the userMessage.
 *   - Other 4xx: surface immediately as a transient failure (consecutive
 *     counter increments). 401/403/404 here are unexpected and should not
 *     keep the loop running silently.
 */
export function startChannelHeartbeat(
  opts: StartChannelHeartbeatOpts,
): HeartbeatHandle {
  const interval = opts.intervalMs ?? 30_000;
  let consecutiveFailures = 0;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    apiClient(`/channels/${opts.channelId}/tunnel/heartbeat`, {
      method: 'POST',
      workspaceId: opts.workspaceId,
    })
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((err: Error & { statusCode?: number; code?: string; userMessage?: string }) => {
        // Terminal signal: 410 from the heartbeat endpoint is only ever the
        // reclaim status today. Stop the loop and surface to the caller —
        // not an error, not a retry.
        if (err.statusCode === 410) {
          stopped = true;
          clearInterval(timer);
          opts.onTerminal({
            code: err.code ?? 'CHANNEL_TUNNEL_RECLAIMED',
            userMessage:
              err.userMessage ??
              err.message ??
              "This channel's destination was changed. The CLI listener has been stopped.",
          });
          return;
        }

        consecutiveFailures += 1;
        if (consecutiveFailures === 1) {
          process.stderr.write(
            `heartbeat: transient failure (${err.message})\n`,
          );
          return;
        }
        if (consecutiveFailures === 2) {
          opts.onError(err);
        }
      });
  }, interval);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
