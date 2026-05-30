// `hookmyapp sandbox logs` — webhook delivery logs for a sandbox session.
//
// Table-by-default (D9): every delivery prints as a one-line summary
//   <time>  <sender>  →  <target-host>  <status> (<latency>)  "<preview>"
// answering "did the message reach my server?" and "what did it say back?"
// without scrolling. Use --verbose for the full dump (inbound body + forward
// attempt request/response) when drilling into a single delivery — the
// `kubectl get pods` → `kubectl describe pod X` pattern.
//
// Modes:
//   default      : fetch last N deliveries, print one-line summary per delivery
//   --verbose    : full inbound body + forward attempt block per delivery (pre-flip default)
//   --json       : JSONL (one full detail DTO per line, no styling)
//   --follow / -f: print initial dump then stream new deliveries in same format
//
// N+1 note: Both human modes make one GET /deliveries/<id> call per row to
// pull the inbound body + attempt detail (the list endpoint only returns
// summaries). At default limit=50 that's ~51 API calls. Acceptable for a
// debug command. A batch detail endpoint would reduce to 2 calls; defer until
// we have telemetry showing latency pain.

import pc from 'picocolors';
import { apiClient } from '../../api/client.js';
import { parseSandboxSessions } from '../../api/sandbox-session.js';
import type { SandboxSession } from '../../api/sandbox-session.js';
import { c } from '../../output/color.js';
import { AuthError } from '../../output/error.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { getEffectiveApiUrl } from '../../config/env-profiles.js';
import { readCredentials } from '../../auth/store.js';
import { pickSession } from './picker.js';
import { sessionIdentifier } from './helpers.js';

// ---------------------------------------------------------------------------
// Wire types (match backend/src/deliveries/dto/delivery.response.ts exactly)
// ---------------------------------------------------------------------------

interface DeliverySummary {
  id: string;
  receivedAt: string;
  metaMessageId: string | null;
  fromPhone: string | null;
  senderId: string | null;
  senderDisplay: string | null;
  routingDecision: string;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusTooltip: string | null;
  humanStatusColor: 'green' | 'red' | 'gray';
  // Flat outcome columns (replaces the old nested latestAttempt sub-object).
  outcome: string;
  forwardStatus: number | null;
  attemptedAt: string | null;
}

interface DeliveriesListResponse {
  deliveries: DeliverySummary[];
  nextCursor: string | null;
  floorHours: number;
}

// Row-per-request model: each row is exactly one forward, so the forward
// fields are flat on the detail (no nested attempts[] array). `forwardUrl ===
// null` means no destination was configured and no forward was attempted.
interface DeliveryDetail {
  id: string;
  routingDecision: string;
  inboundBody: string | null;
  fromPhone: string | null;
  senderDisplay: string | null;
  senderId: string | null;
  receivedAt: string;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusTooltip: string | null;
  humanStatusColor: 'green' | 'red' | 'gray';
  outcome: string;
  outcomeReason: string | null;
  forwardUrl: string | null;
  forwardRequestBody: string | null;
  forwardStatus: number | null;
  forwardDurationMs: number | null;
  forwardResponseBody: string | null;
  attemptedAt: string | null;
}

// JSON-mode projection. humanStatusTooltip + humanStatusColor are GUI-only
// (CLI has no tooltips; colors are picocolors-driven, not hex hints from the
// backend). Stripping them keeps the agent-facing stream lean and avoids
// implying the backend's color choice is canonical for terminal renderers.
function toLogsJson(d: DeliveryDetail): Omit<DeliveryDetail, 'humanStatusTooltip' | 'humanStatusColor'> {
  const { humanStatusTooltip: _t, humanStatusColor: _c, ...rest } = d;
  return rest;
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
// Status color → ANSI mapping (mirrors GUI DOT_CLASS + humanStatusColor)
// ---------------------------------------------------------------------------

function statusDot(color: 'green' | 'red' | 'gray'): string {
  switch (color) {
    case 'green':
      return c.success('●');
    case 'red':
      return c.error('●');
    default:
      return c.dim('●');
  }
}

function statusLabel(label: string, color: 'green' | 'red' | 'gray'): string {
  switch (color) {
    case 'green':
      return c.success(label);
    case 'red':
      return c.error(label);
    default:
      return c.dim(label);
  }
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
  body: string | null | undefined,
  indent = '    ',
  unlimited = false,
): string {
  if (!body) return `${indent}(empty)`;
  let text: string;
  try {
    const parsed: unknown = JSON.parse(body);
    text = JSON.stringify(parsed, null, 2);
  } catch {
    text = body;
  }
  if (!unlimited && text.length > BODY_TRUNCATE_LIMIT) {
    text = text.slice(0, BODY_TRUNCATE_LIMIT) + '\n... [truncated, use --json for full body]';
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

export function printVerboseDelivery(detail: DeliveryDetail, sessionType: string): void {
  const noun = providerNoun(sessionType);
  const dot = statusDot(detail.humanStatusColor);
  const lbl = statusLabel(detail.humanStatus, detail.humanStatusColor);
  const sender = detail.senderDisplay ?? detail.senderId ?? detail.fromPhone ?? 'n/a';
  const relTime = formatRelativeTime(detail.receivedAt);

  // Header line: ● Delivered  Delivered to your app  ·  from 828667679804698  ·  5m ago
  console.log(`${dot} ${lbl}  ${detail.humanStatusCopy}  ·  from ${sender}  ·  ${relTime}`);
  console.log();

  // Inbound body section
  console.log(`  Inbound: What ${noun} sent us:`);
  console.log(formatBodyForTerminal(detail.inboundBody));
  console.log();

  if (detail.forwardUrl === null) {
    // No forward attempt — skipped (no destination) or destination offline.
    if (detail.routingDecision === 'skipped') {
      // Nothing additional needed for skipped; header already conveys it.
    } else {
      console.log(`  ${c.dim('(No forward attempt: destination wasn\'t reachable.)')}`);
    }
  } else {
    // Row-per-request model: exactly one forward, rendered from flat fields.
    const ok =
      detail.forwardStatus != null && detail.forwardStatus >= 200 && detail.forwardStatus < 300;
    const isErr =
      detail.forwardStatus != null && (detail.forwardStatus < 200 || detail.forwardStatus >= 400);
    const statusStr = `HTTP ${detail.forwardStatus ?? 'n/a'} in ${detail.forwardDurationMs ?? 'n/a'}ms`;
    const coloredStatus = ok
      ? c.success(statusStr)
      : isErr
        ? c.error(statusStr)
        : statusStr;

    console.log(`  We sent it to your app`);
    console.log(`    ${pc.bold('POST')} ${detail.forwardUrl}`);
    console.log(`    Request body:`);
    console.log(formatBodyForTerminal(detail.forwardRequestBody));
    console.log();
    console.log(`  Your app responded`);
    console.log(`    ${coloredStatus}`);
    console.log(`    Response body:`);
    console.log(formatBodyForTerminal(detail.forwardResponseBody));
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
// old verbose dump for the rare "I want to see EVERYTHING about ONE row"
// case (kubectl get pods → kubectl describe pod X pattern).
// ---------------------------------------------------------------------------

function printSummaryDelivery(d: DeliveryDetail): void {
  const time = new Date(d.receivedAt).toLocaleString();
  const sender = d.senderDisplay ?? d.senderId ?? '(unknown)';
  const target = (() => {
    if (!d.forwardUrl) return '(no forward URL set)';
    try {
      return new URL(d.forwardUrl).host;
    } catch {
      return '(invalid forward URL)';
    }
  })();
  const status = d.forwardStatus !== null ? `${d.forwardStatus}` : d.outcome;
  const latency =
    d.forwardDurationMs !== null && d.forwardDurationMs !== undefined
      ? `${d.forwardDurationMs}ms`
      : '';
  const preview = previewInbound(d.inboundBody);
  process.stdout.write(
    `${time}  ${sender}  →  ${target}  ${status}${latency ? ` (${latency})` : ''}  ${preview}\n`,
  );
}

function previewInbound(body: string | null): string {
  if (!body) return '(empty)';
  let text: string;
  try {
    const parsed: unknown = JSON.parse(body);
    // Common WA + IG message shapes carry a text body in `text` or `message.text`.
    const obj = parsed as { text?: unknown; message?: { text?: unknown } } | null;
    text = String(obj?.text ?? obj?.message?.text ?? body);
  } catch {
    text = body;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 40) text = text.slice(0, 40) + '…';
  return `"${text}"`;
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
  const initial = (await apiClient(`/deliveries?${qs.toString()}`, { workspaceId })) as DeliveriesListResponse;

  if (opts.json) {
    if (opts.follow) {
      // Streaming: emit the initial dump as JSONL so it's consistent with the
      // live tail that follows below (a stream can't be a closed array).
      for (const summary of initial.deliveries) {
        const detail = (await apiClient(`/deliveries/${summary.id}`, { workspaceId })) as DeliveryDetail;
        process.stdout.write(JSON.stringify(toLogsJson(detail)) + '\n');
      }
    } else {
      // Snapshot: a single JSON array ([] when empty), matching
      // `channels logs list --json` and the other snapshot `--json` commands.
      const dtos: ReturnType<typeof toLogsJson>[] = [];
      for (const summary of initial.deliveries) {
        const detail = (await apiClient(`/deliveries/${summary.id}`, { workspaceId })) as DeliveryDetail;
        dtos.push(toLogsJson(detail));
      }
      console.log(JSON.stringify(dtos, null, 2));
    }
  } else {
    // Human mode: empty state or verbose blocks.
    if (initial.deliveries.length === 0) {
      console.log(
        'No deliveries yet. Send a message to this sandbox to see webhook deliveries appear here in real time.',
      );
    } else {
      for (const summary of initial.deliveries) {
        const detail = (await apiClient(`/deliveries/${summary.id}`, { workspaceId })) as DeliveryDetail;
        if (opts.verbose) {
          printVerboseDelivery(detail, session.type);
        } else {
          printSummaryDelivery(detail);
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
    seenIds: new Set(initial.deliveries.map((d) => d.id)),
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
          const payload = JSON.parse(data) as { eventId?: string };
          const eventId = payload.eventId;
          if (!eventId || seenIds.has(eventId)) continue;
          seenIds.add(eventId);

          // Fetch full delivery detail for the verbose block.
          const detail = (await apiClient(`/deliveries/${eventId}`, { workspaceId })) as DeliveryDetail;
          if (isJson) {
            process.stdout.write(JSON.stringify(toLogsJson(detail)) + '\n');
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
