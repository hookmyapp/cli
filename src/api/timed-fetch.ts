/**
 * Bounded `fetch`. Every outbound request in the CLI goes through here.
 *
 * Node's `fetch` has no default timeout. A server that accepts the connection
 * and then never answers pins the process forever — which is how `mcp-headers`
 * helpers spawned by an MCP client survived for hours and ate a customer's
 * 21 GB of RAM (AIT-540). The CLI is a short-lived tool spawned by agents and
 * CI; nothing here may outlive its command.
 *
 * Two shapes, because one timeout does not fit both:
 *
 *   `timedFetch`        bounds the WHOLE exchange, body included. Right for
 *                       request/response calls where the body is small and
 *                       arrives at once (JSON APIs), and for transfers, with a
 *                       generous budget.
 *
 *   `connectTimedFetch` bounds only the wait for RESPONSE HEADERS, then lets
 *                       the body stream for as long as it likes. Required for
 *                       SSE: `text/event-stream` connections are long-lived by
 *                       design, and a total timeout would cut off a working
 *                       stream mid-flight.
 *
 * A caller that brings its own `signal` keeps it — its lifecycle wins over
 * ours, and Ctrl+C handling must not be silently replaced by a deadline.
 *
 * Aborts surface as a `TimeoutError`, which `isNetworkFailure` (api/client.ts)
 * recognises, so every existing catch block maps them to `NetworkError`
 * (exit 5) without a new error path.
 */

/** Request/response JSON calls. Long enough for a cold TLS handshake on a bad
 *  link, short enough that a wedged connection is not a hang. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Waiting for response headers only — a connect that takes this long is dead
 *  whatever the body would have been. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Whole-transfer budget for bytes: binary downloads, media up/download. A cap
 *  this generous never fires on a working transfer, but a stalled one still
 *  ends. (Per-chunk stall detection needs a custom undici dispatcher; a
 *  generous total cap buys most of the safety for none of the machinery.) */
export const TRANSFER_TIMEOUT_MS = 600_000;

/** Bounds the whole exchange, response body included. */
export function timedFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

/**
 * Bounds the wait for response headers, then leaves the body alone.
 *
 * `fetch` resolves as soon as headers land, so clearing the timer at that
 * point releases the stream: the controller is never aborted and an SSE
 * connection stays open until the caller or the server closes it.
 */
export async function connectTimedFetch(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Response> {
  if (init.signal) return fetch(input, init);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    // Named TimeoutError so it lands in the same bucket as AbortSignal.timeout.
    controller.abort(new DOMException('Connect timed out', 'TimeoutError'));
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
