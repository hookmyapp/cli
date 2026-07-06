// `hookmyapp sandbox logs` — webhook delivery logs for a sandbox session.
//
// Table-by-default: every delivery prints a one-line customer summary.
// Use --verbose for the full Meta payload + app response.
//
// Modes:
//   default      : fetch last N deliveries, print one-line summary per delivery
//   --verbose    : full Meta payload + app response per delivery
//   --json       : JSONL (follow) or one JSON array (snapshot)
//   --follow / -f: print initial snapshot then stream new deliveries in same format
//
import { apiClient } from '../../api/client.js';
import { parseSandboxSessions } from '../../api/sandbox-session.js';
import type { SandboxSession } from '../../api/sandbox-session.js';
import { c } from '../../output/color.js';
import { AuthError } from '../../output/error.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { cleanDeliveryLog, type DeliveryLog } from '../channels-logs/api.js';
import { getEffectiveApiUrl } from '../../config/env-profiles.js';
import { readCredentials } from '../../auth/store.js';
import { pickSession } from './picker.js';
import { sessionIdentifier } from './helpers.js';

interface DeliveriesListResponse {
  logs: DeliveryLog[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Relative time helper — mirrors GUI's formatRelative() in delivery-row.tsx
// (lines 88-114). Pure function; tested directly in logs.test.ts.
// ---------------------------------------------------------------------------

function localDayDiff(a: Date, b: Date): number {
  const aStart = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const bStart = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((bStart - aStart) / (24 * 60 * 60 * 1000));
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const diff = Math.max(0, now - d.getTime());
  const sec = Math.round(diff / 1000);
  if (sec < 5) return 'Just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  // Beyond 24h: calendar-true labels in local timezone.
  const nowD = new Date(now);
  const dayDiff = localDayDiff(d, nowD);
  if (dayDiff <= 0) return `${hr}h ago`; // clock skew safety
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === nowD.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Status color → ANSI mapping for the public delivery status.
// ---------------------------------------------------------------------------

function statusDot(status: DeliveryLog['hookmyapp']['status']): string {
  switch (status) {
    case 'delivered':
      return c.success('●');
    case 'rejected':
    case 'no_response':
    case 'not_delivered':
      return c.error('●');
    default:
      return c.dim('●');
  }
}

function statusLabel(log: DeliveryLog): string {
  switch (log.hookmyapp.status) {
    case 'delivered':
      return c.success(log.hookmyapp.statusText);
    case 'rejected':
    case 'no_response':
    case 'not_delivered':
      return c.error(log.hookmyapp.statusText);
    default:
      return c.dim(log.hookmyapp.statusText);
  }
}

function destinationLine(log: DeliveryLog): string | null {
  const destination = log.hookmyapp.destination;
  if (!destination) return null;
  if (destination.type === 'cli') return 'To: CLI listener';
  return `To: ${destination.url}`;
}

function destinationHost(log: DeliveryLog): string {
  const destination = log.hookmyapp.destination;
  if (!destination) return '(no destination)';
  if (destination.type === 'cli') return 'CLI listener';
  try {
    return new URL(destination.url).host;
  } catch {
    return destination.url;
  }
}

function responseText(log: DeliveryLog): string {
  const response = log.hookmyapp.appResponse;
  if (response.status === null) return '(no response)';
  return `${response.status}${
    response.durationMs === null ? '' : ` (${response.durationMs}ms)`
  }`;
}

function colorResponse(log: DeliveryLog): string {
  const status = log.hookmyapp.appResponse.status;
  const text = responseText(log);
  if (status !== null && status >= 200 && status < 300) {
    return c.success(text);
  }
  if (status !== null && (status < 200 || status >= 400)) {
    return c.error(text);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Body formatting helpers
// ---------------------------------------------------------------------------

const BODY_TRUNCATE_LIMIT = 4096;
const SEPARATOR = c.dim('─'.repeat(68));

// formatBodyForTerminal — pretty-prints a JSON body string, indented by `indent`.
// Non-JSON falls back to raw text. Truncates at BODY_TRUNCATE_LIMIT chars in
// human mode (pass unlimited=true to skip truncation, e.g. --json mode).
function formatBodyForTerminal(
  body: unknown,
  indent = '    ',
  unlimited = false,
): string {
  if (body === null || body === undefined || body === '') return `${indent}(empty)`;
  const text =
    typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  if (!unlimited && text.length > BODY_TRUNCATE_LIMIT) {
    return `${text.slice(0, BODY_TRUNCATE_LIMIT)}\n... [truncated, use --json for full body]`
      .split('\n')
      .map((l) => `${indent}${l}`)
      .join('\n');
  }
  return text
    .split('\n')
    .map((l) => `${indent}${l}`)
    .join('\n');
}

// Derive the provider noun from session.type for copy like "What X sent us:".
function providerNoun(sessionType: string): string {
  switch (sessionType) {
    case 'instagram':
      return 'Instagram';
    case 'whatsapp':
    default:
      return 'WhatsApp';
  }
}

// ---------------------------------------------------------------------------
// Verbose block renderer — mirrors GUI expanded row content.
// Call from both the initial-page loop and the SSE event handler.
// ---------------------------------------------------------------------------

export function printVerboseDelivery(detail: DeliveryLog, sessionType: string): void {
  const noun = providerNoun(sessionType);
  const dot = statusDot(detail.hookmyapp.status);
  const lbl = statusLabel(detail);
  const sender = detail.sender ?? 'n/a';
  const relTime = formatRelativeTime(detail.receivedAt);

  console.log(`${dot} ${lbl}  ·  from ${sender}  ·  ${relTime}`);
  console.log();

  console.log(`  Meta payload: What ${noun} sent us:`);
  console.log(formatBodyForTerminal(detail.meta));
  console.log();

  const destination = destinationLine(detail);
  if (destination) {
    console.log(`  ${destination}`);
    console.log();
  }

  console.log(`  Your app responded`);
  console.log(`    ${colorResponse(detail)}`);
  if (detail.hookmyapp.appResponse.body !== null) {
    console.log(`    Response body:`);
    console.log(formatBodyForTerminal(detail.hookmyapp.appResponse.body));
    console.log();
  }

  console.log(SEPARATOR);
}

// ---------------------------------------------------------------------------
// Summary renderer (D9 — table-by-default) — one line per delivery.
//
// Columns: <local-time>  <senderDisplay>  →  <target-host>  <status>  (<latency>ms)  "<preview>"
//
// The two questions a customer reading `sandbox logs` is answering are
//   1. did the message reach my server?
//   2. what did my server say back?
// Both are visible per row without scrolling. --verbose returns the
// verbose detail for the rare "I want to inspect the full payload for one row"
// case (kubectl get pods → kubectl describe pod X pattern).
// ---------------------------------------------------------------------------

function printSummaryDelivery(d: DeliveryLog): void {
  const time = new Date(d.receivedAt).toLocaleString();
  const sender = d.sender ?? '(unknown)';
  const target = destinationHost(d);
  const status = responseText(d);
  const preview = previewMeta(d.meta);
  process.stdout.write(
    `${time}  ${sender}  →  ${target}  ${d.hookmyapp.statusText}  ${status}  ${preview}\n`,
  );
}

function previewMeta(body: unknown): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  if (!raw) return '(empty)';
  const text = raw.replace(/\s+/g, ' ').trim();
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSandboxLogs(opts: {
  identifierArg?: string;
  phone?: string;
  username?: string;
  session?: string;
  limit?: number;
  follow?: boolean;
  json?: boolean;
  verbose?: boolean;
}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const isHumanTty = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    identifierArg: opts.identifierArg,
    phoneFlag: opts.phone,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman: isHumanTty,
  });

  const scope = `sandbox-session:${session.id}`;
  // Clamp to 1–100 inclusive (mirrors backend @Min(1) @Max(100) validator).
  // `??` only catches null/undefined, NOT NaN — a programmatic NaN limit would
  // otherwise send `limit=NaN`, which the backend 400s (and the error renderer
  // crashed on the non-string body — Sentry HOOKMYAPP-CLI-J). The CLI option
  // parser rejects non-numeric --limit locally (exit 2); this is the last-line
  // guard for any other caller. Treat non-finite as the default 50.
  const requested = Number.isFinite(opts.limit) ? (opts.limit as number) : 50;
  const limit = Math.min(Math.max(requested, 1), 100);

  const qs = new URLSearchParams({ scope, limit: String(limit) });
  const initialRaw = (await apiClient(`/deliveries?${qs.toString()}`, { workspaceId })) as DeliveriesListResponse;
  const initial: DeliveriesListResponse = {
    logs: initialRaw.logs.map(cleanDeliveryLog),
    nextCursor: initialRaw.nextCursor,
  };

  if (opts.json) {
    if (opts.follow) {
      // Streaming: emit the initial snapshot as JSONL so it's consistent with the
      // live tail that follows below (a stream can't be a closed array).
      for (const log of initial.logs) {
        process.stdout.write(JSON.stringify(log) + '\n');
      }
    } else {
      // Snapshot: a single JSON array ([] when empty), matching
      // `channels logs list --json` and the other snapshot `--json` commands.
      console.log(JSON.stringify(initial.logs, null, 2));
    }
  } else {
    // Human mode: empty state or verbose blocks.
    if (initial.logs.length === 0) {
      console.log(
        'No deliveries yet. Send a message to this sandbox to see webhook deliveries appear here in real time.',
      );
    } else {
      for (const log of initial.logs) {
        if (opts.verbose) {
          printVerboseDelivery(log, session.type);
        } else {
          printSummaryDelivery(log);
        }
      }
    }
  }

  if (!opts.follow) return;

  // Live tail via SSE.
  await runFollow({
    scope,
    workspaceId,
    isJson: !!opts.json,
    verbose: !!opts.verbose,
    session,
    seenIds: new Set(),
  });
}

// ---------------------------------------------------------------------------
// SSE follow mode — streams new deliveries from /deliveries/stream
//
// Auth: Bearer + X-Workspace-Id in request headers (same as all apiClient
// calls). The frontend hook uses @microsoft/fetch-event-source with `credentials:
// 'include'` (cookie-based in browser). CLI uses explicit Bearer header which
// is the correct pattern for non-browser clients (use-deliveries-stream.ts
// sets X-Workspace-Id in headers too, confirming header-based auth is valid).
// ---------------------------------------------------------------------------

async function runFollow(args: {
  scope: string;
  workspaceId: string;
  isJson: boolean;
  verbose: boolean;
  session: SandboxSession;
  seenIds: Set<string>;
}): Promise<void> {
  const { scope, workspaceId, isJson, verbose, session, seenIds } = args;

  const creds = await readCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run: hookmyapp login');
  }

  const base = getEffectiveApiUrl().replace(/\/$/, '');
  const url = `${base}/deliveries/stream?scope=${encodeURIComponent(scope)}`;

  if (!isJson) {
    console.log(c.dim('Streaming new deliveries… (Ctrl+C to stop)'));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'X-Workspace-Id': workspaceId,
        Accept: 'text/event-stream',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthError(`SSE connect failed: ${msg}`);
  }

  if (!res.ok || !res.body) {
    throw new AuthError(`SSE connect failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are double-newline-delimited.
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data += line.slice(5).trim();
        }
      }

      if (event === 'delivery' && data) {
        try {
          const payload = JSON.parse(data) as { eventId?: string; publicId?: string };
          const eventId = payload.eventId ?? payload.publicId;
          if (!eventId || seenIds.has(eventId)) continue;
          seenIds.add(eventId);

          const detail = cleanDeliveryLog((await apiClient(`/deliveries/${eventId}`, { workspaceId })) as DeliveryLog);
          if (isJson) {
            process.stdout.write(JSON.stringify(detail) + '\n');
          } else if (verbose) {
            printVerboseDelivery(detail, session.type);
          } else {
            printSummaryDelivery(detail);
          }
        } catch {
          // Skip malformed event or transient fetch error.
        }
      }

      if (event === 'taken_over' || event === 'closed') {
        if (!isJson) {
          console.log(c.dim(`Stream ${event}.`));
        }
        return;
      }
    }
  }
}

// Exported only so logs.test.ts can import without re-exporting the whole module.
export { sessionIdentifier };
