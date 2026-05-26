// `hookmyapp sandbox logs` — read webhook delivery logs for a sandbox session.
//
// Mirrors the GUI Deliveries panel verbatim: same status labels, copy, colors,
// sender, and relative time. The ONE deliberate CLI deviation from the GUI is
// appending the first 8 chars of the delivery id at the end of each list row.
// The GUI has no need for a stable copy-pasteable identifier (users click to
// expand). The CLI cannot click, so `--detail <id>` is the mechanism for
// expansion — and the 8-char id at the end of the row is the cue that you
// can pass it there. It's the minimum necessary deviation to preserve the
// "no invisible state" principle of a good CLI.
//
// Modes:
//   default      : fetch last N deliveries, print one row per delivery (human)
//   --json       : JSONL (one backend DTO per line, no styling)
//   --follow / -f: print initial list then stream new deliveries via SSE
//   --detail <id>: fetch + print one full delivery (inbound body + attempts)

import pc from 'picocolors';
import { apiClient } from '../../api/client.js';
import { parseSandboxSessions } from '../../api/sandbox-session.js';
import { c } from '../../output/color.js';
import { AuthError, ValidationError } from '../../output/error.js';
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
// Row rendering — matches GUI list row shape exactly (+ 8-char id deviation)
//
// GUI column order (delivery-row.tsx:155-224):
//   ● | humanStatus | humanStatusCopy | from {senderDisplay} | timestamp
//
// CLI adds: 8-char id at the end (see top-of-file comment for justification)
//
// Fixed column widths after ANSI stripping (padEnd on plain text before color):
//   status label  : 14 chars
//   status copy   : 36 chars
//   sender        : 22 chars
//   timestamp     : 12 chars
//   id (8 chars)  : trailing dim
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
  // Strips ESC [ ... m sequences emitted by picocolors.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(s: string, width: number): string {
  const plain = stripAnsi(s);
  const needed = width - plain.length;
  return needed > 0 ? s + ' '.repeat(needed) : s;
}

export function formatListRow(d: DeliverySummary, now = Date.now()): string {
  const dot = statusDot(d.humanStatusColor);
  const lbl = pad(statusLabel(d.humanStatus, d.humanStatusColor), 14);
  const copy = pad(c.dim(d.humanStatusCopy), 36);
  const sender = d.senderDisplay
    ? pad(c.dim(`from ${d.senderDisplay}`), 22)
    : pad('', 22);
  const ts = pad(formatRelativeTime(d.receivedAt, now), 12);
  const shortId = c.dim(d.id.slice(0, 8));
  return `${dot} ${lbl} ${copy} ${sender} ${ts} ${shortId}`;
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
  detail?: string;
  json?: boolean;
}): Promise<void> {
  // --detail short-circuits: no session picker needed.
  if (opts.detail) {
    return runDetail(opts.detail, !!opts.json);
  }

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
    for (const d of initial.deliveries) {
      process.stdout.write(JSON.stringify(d) + '\n');
    }
  } else {
    // Empty state (mirrors GUI: "No deliveries yet. Send a message to this
    // sandbox to see webhook deliveries appear here in real time.")
    if (initial.deliveries.length === 0) {
      console.log(
        'No deliveries yet. Send a message to this sandbox to see webhook deliveries appear here in real time.',
      );
    } else {
      const now = Date.now();
      for (const d of initial.deliveries) {
        console.log(formatListRow(d, now));
      }
    }
  }

  if (!opts.follow) return;

  // Live tail via SSE.
  await runFollow({
    scope,
    workspaceId,
    isJson: !!opts.json,
    seenIds: new Set(initial.deliveries.map((d) => d.id)),
  });
}

// ---------------------------------------------------------------------------
// Detail mode — mirrors GUI ExpandedDetail (delivery-row.tsx:239-283)
// ---------------------------------------------------------------------------

async function runDetail(id: string, isJson: boolean): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const detail = (await apiClient(`/deliveries/${id}`, { workspaceId })) as DeliveryDetail;

  if (isJson) {
    process.stdout.write(JSON.stringify(detail, null, 2) + '\n');
    return;
  }
  printDetail(detail);
}

function printDetail(detail: DeliveryDetail): void {
  const a = detail.attempts[0] ?? null;
  console.log();

  if (!a) {
    // No attempts: show inbound body + no-destination alert (GUI lines 249-257)
    console.log(pc.bold('What WhatsApp sent us'));
    console.log(formatBody(detail.inboundBody));
    console.log();
    console.log(
      c.dim(
        'We got this message but couldn\'t forward it because no destination was configured at the time. Future messages will be delivered once one is set up.',
      ),
    );
  } else {
    // Has attempt: show forward request + app response (GUI lines 258-268)
    console.log(pc.bold('We sent it to your app'));
    console.log(`  POST ${a.forwardUrl}`);
    console.log('  Request body:');
    console.log(formatBody(a.forwardRequestBody, '    '));
    console.log();

    const ok = a.forwardStatus != null && a.forwardStatus >= 200 && a.forwardStatus < 300;
    const statusStr = `HTTP ${a.forwardStatus ?? '—'} in ${a.forwardDurationMs ?? '—'}ms`;
    console.log(pc.bold('Your app responded'));
    console.log(`  ${ok ? c.success(statusStr) : c.error(statusStr)}`);
    console.log('  Response body:');
    console.log(formatBody(a.forwardResponseBody, '    '));
  }
  console.log();
}

function formatBody(body: string | null | undefined, indent = '  '): string {
  if (!body) return `${indent}(empty)`;
  try {
    const parsed: unknown = JSON.parse(body);
    return JSON.stringify(parsed, null, 2)
      .split('\n')
      .map((l) => `${indent}${l}`)
      .join('\n');
  } catch {
    const truncated = body.length > 2048 ? body.slice(0, 2048) + '... [truncated]' : body;
    return truncated
      .split('\n')
      .map((l) => `${indent}${l}`)
      .join('\n');
  }
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
  seenIds: Set<string>;
}): Promise<void> {
  const { scope, workspaceId, isJson, seenIds } = args;

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

          // Fetch full delivery detail so we have all list-row fields.
          const detail = (await apiClient(`/deliveries/${eventId}`, { workspaceId })) as DeliveryDetail;
          if (isJson) {
            process.stdout.write(JSON.stringify(detail) + '\n');
          } else {
            console.log(formatListRow(toSummary(detail)));
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

// Project the full DeliveryDetail (from /deliveries/:id) down to the
// DeliverySummary shape used by formatListRow. Used during SSE follow mode.
function toSummary(detail: DeliveryDetail): DeliverySummary {
  const attempts = Array.isArray(detail.attempts) ? detail.attempts : [];
  const latest = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  return {
    id: detail.id,
    receivedAt: detail.receivedAt,
    fromPhone: detail.fromPhone ?? null,
    senderId: detail.senderId ?? null,
    senderDisplay: detail.senderDisplay ?? null,
    routingDecision: detail.routingDecision ?? '—',
    attemptsCount: attempts.length,
    humanStatus: detail.humanStatus ?? '—',
    humanStatusCopy: detail.humanStatusCopy ?? '',
    humanStatusTooltip: detail.humanStatusTooltip ?? null,
    humanStatusColor: detail.humanStatusColor ?? 'gray',
    latestAttempt: latest
      ? {
          outcome: latest.outcome,
          forwardStatus: latest.forwardStatus ?? null,
          attemptedAt: latest.attemptedAt,
        }
      : null,
  };
}

// Exported only so logs.test.ts can import without re-exporting the whole module.
export { sessionIdentifier };
