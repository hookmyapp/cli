// `hookmyapp sandbox logs` — verbose dump of webhook delivery logs for a sandbox session.
//
// Verbose-by-default: every delivery prints with the full inbound body + forward
// attempt(s) inline. Debugging is the only use case for this command — no flag
// exploration needed to get full bodies. Mirrors the GUI Deliveries panel's
// expanded-row content (inbound body + forward request + app response).
//
// Modes:
//   default      : fetch last N deliveries, print verbose block per delivery (human)
//   --json       : JSONL (one full detail DTO per line, no styling)
//   --follow / -f: print initial verbose dump then stream new deliveries in same format
//
// N+1 note: Verbose-by-default makes one GET /deliveries/<id> call per row. At
// default limit=50 that's ~51 API calls. Acceptable for a debug command. A batch
// detail endpoint would reduce to 2 calls; defer until we have telemetry showing
// latency pain.

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
  fromPhone: string | null;
  senderId: string | null;
  senderDisplay: string | null;
  routingDecision: string;
  attemptsCount: number;
  humanStatus: string;
  humanStatusCopy: string;
  humanStatusTooltip: string | null;
  humanStatusColor: 'green' | 'red' | 'gray';
  latestAttempt: {
    outcome: string;
    forwardStatus: number | null;
    attemptedAt: string;
  } | null;
}

interface DeliveriesListResponse {
  deliveries: DeliverySummary[];
  nextCursor: string | null;
  floorHours: number;
}

interface DeliveryAttemptDetail {
  id: string;
  attemptNumber: number;
  forwardUrl: string;
  forwardRequestBody: string | null;
  forwardStatus: number | null;
  forwardDurationMs: number | null;
  forwardResponseBody: string | null;
  outcome: string;
  attemptedAt: string;
}

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
  attempts: DeliveryAttemptDetail[];
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
    text = text.slice(0, BODY_TRUNCATE_LIMIT) + '\n... [truncated — use --json for full body]';
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
  const sender = detail.senderDisplay ?? detail.senderId ?? detail.fromPhone ?? '—';
  const relTime = formatRelativeTime(detail.receivedAt);

  // Header line: ● Delivered  Delivered to your app  ·  from 828667679804698  ·  5m ago
  console.log(`${dot} ${lbl}  ${detail.humanStatusCopy}  ·  from ${sender}  ·  ${relTime}`);
  console.log();

  // Inbound body section
  console.log(`  What ${noun} sent us:`);
  console.log(formatBodyForTerminal(detail.inboundBody));
  console.log();

  if (detail.attempts.length === 0) {
    // Skipped or destination offline — no attempt made.
    if (detail.routingDecision === 'skipped') {
      // Nothing additional needed for skipped; header already conveys it.
    } else {
      console.log(`  ${c.dim('(No forward attempt — destination wasn\'t reachable.)')}`);
    }
  } else {
    // Render each attempt (usually just 1; show all for completeness).
    for (const a of detail.attempts) {
      const ok =
        a.forwardStatus != null && a.forwardStatus >= 200 && a.forwardStatus < 300;
      const isErr =
        a.forwardStatus != null && (a.forwardStatus < 200 || a.forwardStatus >= 400);
      const statusStr = `HTTP ${a.forwardStatus ?? '—'} in ${a.forwardDurationMs ?? '—'}ms`;
      const coloredStatus = ok
        ? c.success(statusStr)
        : isErr
          ? c.error(statusStr)
          : statusStr;

      console.log(`  We sent it to your app`);
      console.log(`    ${pc.bold('POST')} ${a.forwardUrl}`);
      console.log(`    Request body:`);
      console.log(formatBodyForTerminal(a.forwardRequestBody));
      console.log();
      console.log(`  Your app responded`);
      console.log(`    ${coloredStatus}`);
      console.log(`    Response body:`);
      console.log(formatBodyForTerminal(a.forwardResponseBody));
      console.log();
    }
  }

  console.log(SEPARATOR);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSandboxLogs(opts: {
  phone?: string;
  username?: string;
  session?: string;
  limit?: number;
  follow?: boolean;
  json?: boolean;
}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const isHumanTty = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    phoneFlag: opts.phone,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman: isHumanTty,
  });

  const scope = `sandbox-session:${session.id}`;
  // Clamp to 1–100 inclusive (mirrors backend @Min(1) @Max(100) validator).
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

  const qs = new URLSearchParams({ scope, limit: String(limit) });
  const initial = (await apiClient(`/deliveries?${qs.toString()}`, { workspaceId })) as DeliveriesListResponse;

  if (opts.json) {
    // JSON mode: fetch full detail for each summary and emit one DTO per line.
    for (const summary of initial.deliveries) {
      const detail = (await apiClient(`/deliveries/${summary.id}`, { workspaceId })) as DeliveryDetail;
      process.stdout.write(JSON.stringify(detail) + '\n');
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
        printVerboseDelivery(detail, session.type);
      }
    }
  }

  if (!opts.follow) return;

  // Live tail via SSE.
  await runFollow({
    scope,
    workspaceId,
    isJson: !!opts.json,
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
  session: SandboxSession;
  seenIds: Set<string>;
}): Promise<void> {
  const { scope, workspaceId, isJson, session, seenIds } = args;

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
            process.stdout.write(JSON.stringify(detail) + '\n');
          } else {
            printVerboseDelivery(detail, session.type);
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
