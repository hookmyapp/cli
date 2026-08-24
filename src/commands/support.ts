import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { NetworkError, ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { isTelemetryEnabled, maybePrintFirstRunDisclosure } from '../observability/telemetry.js';

/**
 * AIT-337 — `hookmyapp support`: open and follow support tickets from the CLI
 * (built so AI agents driving the CLI can report problems firsthand).
 * Thin wrapper over /support/tickets*; the backend owns identity, limits,
 * and the reply long-poll.
 */

const TICKET_ID = /^sup_[1-9][0-9]*$/;

interface TicketSummary {
  ticketId: string;
  subject: string;
  status: string;
  lastActivityAt: string;
}

interface TicketMessage {
  role: 'you' | 'support';
  text: string;
  at: string;
}

export interface TicketDetail {
  ticketId: string;
  subject: string;
  status: string;
  messages: TicketMessage[];
  nextCursor: string;
  note?: string;
}

// ── support watch internals (AIT-346) ──────────────────────────────────────

const DURATION = /^(\d+)(s|m|h)$/;
const WATCH_CAP_MS = 2 * 60 * 60 * 1000;
const CYCLE_MS = 25_000;
const MAX_TRANSIENT_FAILURES = 3;

function parseTimeout(value: string): number {
  const m = DURATION.exec(value);
  if (!m) throw new ValidationError('--timeout must look like 90s, 10m, or 2h.');
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  if (ms < 1000 || ms > WATCH_CAP_MS) {
    throw new ValidationError('--timeout must be between 1s and 2h.');
  }
  return ms;
}

function isTransient(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  // Our own per-cycle abort (stalled transport) — retry next cycle; the
  // deadline check turns it into the timeout outcome when time is up.
  const name = (err as Error).name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = (err as { code?: string }).code ?? '';
  const status = (err as { statusCode?: number }).statusCode ?? 0;
  // SUPPORT_NOT_CONFIGURED / SUPPORT_MISCONFIGURED are 503s but describe a
  // static config state — retrying cannot help; keep them terminal.
  if (code === 'SUPPORT_UPSTREAM_TIMEOUT' || code === 'SUPPORT_UPSTREAM_UNAVAILABLE') return true;
  return status >= 500 && !code.startsWith('SUPPORT_');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** ≥25s per cycle (never busy-poll, even when the server answers early), but
 * never sleeping past the absolute deadline. */
async function paceSleep(cycleStart: number, deadline: number): Promise<void> {
  const pace = CYCLE_MS - (Date.now() - cycleStart);
  const untilDeadline = deadline - Date.now();
  await sleep(Math.max(0, Math.min(pace, untilDeadline)));
}

interface WatchResult {
  reason: 'message' | 'resolved' | 'timeout' | 'error';
  detail?: TicketDetail;
  cursor: string | null;
  resume: string;
  error?: { code: string; message: string };
}

function assertTicketId(id: string): void {
  if (!TICKET_ID.test(id)) {
    throw new ValidationError(
      `Invalid ticket id "${id}" — expected sup_<number>. Run: hookmyapp support list`,
    );
  }
}

function parseWait(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 25) {
    throw new ValidationError('--wait must be an integer between 1 and 25 seconds.');
  }
  return n;
}

async function readStdinBody(): Promise<string> {
  return new Promise<string>((res, rej) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => res(buf.trim()));
    process.stdin.on('error', rej);
  });
}

function printDetail(detail: TicketDetail): void {
  console.log(`Ticket ${detail.ticketId} — ${detail.subject} (${detail.status})`);
  for (const m of detail.messages) {
    console.log(`[${m.role}] ${m.at}  ${m.text}`);
  }
  console.log('(showing up to the 20 most recent messages)');
  if (detail.note) console.log(detail.note);
  if (detail.nextCursor) {
    console.log(`Next check: hookmyapp support show ${detail.ticketId} --wait 20 --after ${detail.nextCursor}`);
  }
}

export function registerSupportCommand(program: Command): void {
  const support = program
    .command('support')
    .description('Contact HookMyApp support — open tickets and read replies');

  addExamples(
    support,
    `
EXAMPLES:
  $ hookmyapp support new --subject "send_message returns 500" -m "…what you tried, exact error…"
  $ hookmyapp support show sup_42 --wait 20
`,
  );

  const sNew = support
    .command('new')
    .description(
      'Open a support ticket. Describe what you tried, what happened, and the exact error text. ' +
        'Do not include secrets or your customers’ message content.',
    )
    .requiredOption('--subject <subject>', 'One-line summary (max 200 chars)')
    .option('-m, --message <message>', 'Ticket body; omit to read it from stdin')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { subject: string; message?: string; json?: boolean }) => {
      const description = opts.message ?? (await readStdinBody());
      if (!description) throw new ValidationError('Provide a body with -m or pipe it on stdin.');
      const res = (await apiClient('/support/tickets', {
        method: 'POST',
        body: JSON.stringify({ subject: opts.subject, description }),
      })) as { ticketId: string; status: string };
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        `Ticket ${res.ticketId} opened (${res.status}). Check replies: hookmyapp support show ${res.ticketId}`,
      );
    });
  addExamples(
    sNew,
    `
EXAMPLES:
  $ hookmyapp support new --subject "send_message returns 500" -m "Called send_message with channelId ch_abc; got HTTP 500. Worked yesterday."
  $ hookmyapp support new --subject "webhook deliveries stuck" < error-report.md
`,
  );

  const sList = support
    .command('list')
    .description("List your organization's 20 most recent support tickets")
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const res = (await apiClient('/support/tickets')) as { tickets: TicketSummary[] };
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(res.tickets, null, 2));
        return;
      }
      if (res.tickets.length === 0) {
        console.log('No support tickets yet. Open one: hookmyapp support new --subject "…" -m "…"');
        return;
      }
      output(
        res.tickets.map((t) => ({
          ID: t.ticketId,
          SUBJECT: t.subject,
          STATUS: t.status,
          'LAST ACTIVITY': t.lastActivityAt,
        })),
        { human: true },
      );
    });
  addExamples(
    sList,
    `
EXAMPLES:
  $ hookmyapp support list
  $ hookmyapp support list --json
`,
  );

  const sShow = support
    .command('show')
    .description('Read a ticket conversation; --wait holds up to 25s for a new support reply')
    .argument('<id>', 'Ticket id (sup_…)')
    .option('--wait <seconds>', 'Hold up to N seconds (1-25) for a new support reply')
    .option('--after <cursor>', 'Opaque cursor from a previous response (nextCursor)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id: string, opts: { wait?: string; after?: string; json?: boolean }) => {
      assertTicketId(id);
      const params = new URLSearchParams();
      if (opts.wait !== undefined) params.set('wait', String(parseWait(opts.wait)));
      if (opts.after) params.set('afterCursor', opts.after);
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const detail = (await apiClient(`/support/tickets/${id}${qs}`)) as TicketDetail;
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      printDetail(detail);
    });
  addExamples(
    sShow,
    `
EXAMPLES:
  $ hookmyapp support show sup_42
  $ hookmyapp support show sup_42 --wait 20 --after <nextCursor>
`,
  );

  const sWatch = support
    .command('watch')
    .description('Wait for the next support reply — long-running, exits when support answers')
    .argument('<id>', 'Ticket id (sup_…)')
    .option('--timeout <duration>', 'Give up after this long (90s / 10m / 2h, max 2h)', '30m')
    .option('--after <cursor>', 'Opaque cursor from a previous response (nextCursor)')
    .option('--json', 'Output a WatchResult JSON envelope')
    .action(async (id: string, opts: { timeout: string; after?: string; json?: boolean }) => {
      assertTicketId(id);
      const timeoutMs = parseTimeout(opts.timeout);
      const deadline = Date.now() + timeoutMs;
      let cursor: string | undefined = opts.after;
      let failures = 0;
      const useJson = opts.json || program.opts().json;

      const resume = (): string =>
        cursor
          ? `hookmyapp support watch ${id} --after ${cursor}`
          : `hookmyapp support watch ${id}`;
      const emit = (result: WatchResult): void => {
        if (useJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.detail) printDetail(result.detail);
        // A reply can arrive together with resolution — always surface it.
        if (result.reason === 'resolved' || result.detail?.status === 'resolved') {
          console.log(`Ticket ${id} was resolved.`);
        }
        if (result.reason === 'timeout') console.log(`no reply within ${opts.timeout}`);
        console.log(`Resume: ${result.resume}`);
      };

      while (true) {
        const cycleStart = Date.now();
        const remainingMs = deadline - cycleStart;
        if (remainingMs <= 0) {
          emit({ reason: 'timeout', cursor: cursor ?? null, resume: resume() });
          process.exitCode = 1;
          return;
        }
        // The final cycle shortens the server wait so the deadline holds.
        const wait = Math.min(25, Math.max(1, Math.floor(remainingMs / 1000)));
        let detail: TicketDetail;
        try {
          const qs = new URLSearchParams({ wait: String(wait) });
          if (cursor) qs.set('afterCursor', cursor);
          // Bound each poll: server holds `wait`s; anything much longer is a
          // stalled transport. Without this, --timeout is not a real deadline.
          detail = (await apiClient(`/support/tickets/${id}?${qs}`, {
            signal: AbortSignal.timeout(wait * 1000 + 15_000),
          })) as TicketDetail;
        } catch (err) {
          if (isTransient(err) && ++failures < MAX_TRANSIENT_FAILURES) {
            await paceSleep(cycleStart, deadline);
            continue;
          }
          if (useJson) {
            const e = err as { code?: string; message?: string; exitCode?: number };
            emit({
              reason: 'error',
              cursor: cursor ?? null,
              resume: resume(),
              error: { code: e.code ?? 'UNKNOWN', message: e.message ?? 'error' },
            });
            process.exitCode = e.exitCode ?? 1;
            return; // single envelope — the top-level renderer must not add a second
          }
          console.error(`Resume: ${resume()}`);
          throw err; // human mode: top-level renders the error with its exit family
        }
        failures = 0;
        cursor = detail.nextCursor;
        if (!detail.note) {
          emit({ reason: 'message', detail, cursor, resume: resume() });
          return; // exit 0
        }
        if (detail.status === 'resolved') {
          emit({ reason: 'resolved', detail, cursor, resume: resume() });
          return; // exit 0
        }
        await paceSleep(cycleStart, deadline);
      }
    });
  addExamples(
    sWatch,
    `
EXAMPLES:
  $ hookmyapp support watch sup_42
  $ hookmyapp support watch sup_42 --timeout 2h --after bWlkOjEyMw
`,
  );

  const sReply = support
    .command('reply')
    .description('Send a follow-up on a ticket (replying to a resolved ticket reopens it)')
    .argument('<id>', 'Ticket id (sup_…)')
    .option('-m, --message <message>', 'Your follow-up message (or pipe it on stdin)')
    .option('--wait <seconds>', 'Hold up to N seconds (1-25) for a support reply')
    .option('--after <cursor>', 'Opaque cursor from a previous response (nextCursor)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id: string, opts: { message?: string; wait?: string; after?: string; json?: boolean }) => {
      assertTicketId(id);
      const message = opts.message ?? (await readStdinBody());
      const body: Record<string, unknown> = { message };
      if (opts.wait !== undefined) body.wait = parseWait(opts.wait);
      if (opts.after) body.afterCursor = opts.after;
      const detail = (await apiClient(`/support/tickets/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      })) as TicketDetail;
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      printDetail(detail);
    });
  addExamples(
    sReply,
    `
EXAMPLES:
  $ hookmyapp support reply sup_42 -m "Still failing after retry"
  $ hookmyapp support reply sup_42 -m "More details attached below" --wait 20
  $ hookmyapp support reply sup_42 < more-details.md
`,
  );
}

/**
 * AIT-458 — `hookmyapp feedback`: one-way friction report for the agent driving
 * this CLI. Separate command, not `support new --kind`, because agents route on
 * descriptions: nothing in a support description fires when the human is merely
 * confused. Governed by the existing telemetry switch — no second consent
 * surface, and telemetry off means nothing leaves the machine.
 */
export function registerFeedbackCommand(program: Command): void {
  const feedback = program
    .command('feedback')
    .description(
      'Report friction you observed: the human got confused, repeated themselves, misread an error, ' +
        'abandoned a flow, or declined an upgrade after hitting a plan limit. One-way — nobody replies. ' +
        'If something is broken or they need an answer, use `hookmyapp support new` instead.',
    )
    .argument('[message]', 'What they were trying to do and what confused them (a summary, never a transcript)')
    .option('--surface <surface>', 'Where it happened: cli, mcp, docs, dashboard, api', 'cli')
    .option('--json', 'Output machine-readable JSON')
    .action(async (message: string | undefined, opts: { surface: string; json?: boolean }) => {
      // Validate and check the switch BEFORE touching stdin: otherwise a typo'd
      // --surface blocks on a pipe instead of reporting itself.
      if (!SURFACES.includes(opts.surface)) {
        throw new ValidationError(`--surface must be one of: ${SURFACES.join(', ')}.`);
      }
      if (!isTelemetryEnabled()) {
        // Same switch as crash reporting: off means nothing leaves the machine.
        const note = 'Telemetry is off, so nothing was sent. Turn it on: hookmyapp config set telemetry on';
        console.log(opts.json || program.opts().json ? JSON.stringify({ sent: false, note }, null, 2) : note);
        return;
      }
      // `feedback` has no required option, so a bare invocation is the likely
      // typo — never silently block forever on an interactive terminal.
      if (message === undefined && process.stdin.isTTY) {
        throw new ValidationError('Provide the feedback as an argument or pipe it on stdin.');
      }
      const body = message ?? (await readStdinBody());
      if (!body) throw new ValidationError('Provide the feedback as an argument or pipe it on stdin.');
      // This is the moment data leaves the machine, so it is the moment the
      // disclosure has to have been shown — it cannot depend on Sentry having
      // initialized (no DSN in a local or self-built CLI means no banner).
      maybePrintFirstRunDisclosure();
      const res = (await apiClient('/support/feedback', {
        method: 'POST',
        body: JSON.stringify({ message: body, surface: opts.surface }),
      })) as { ticketId: string; note?: string };
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify({ sent: true, ...res }, null, 2));
        return;
      }
      console.log(`Thanks — recorded as ${res.ticketId}.${res.note ? ` ${res.note}` : ''}`);
    });

  addExamples(
    feedback,
    `
EXAMPLES:
  $ hookmyapp feedback "Spent 20 minutes on the connect flow; read 'pending' as an error and nearly gave up."
  $ hookmyapp feedback "Hit the plan limit and decided not to upgrade — said the price is too high for their volume."
  $ hookmyapp feedback --surface docs "The webhook signature page never says which header carries the timestamp."
`,
  );
}

const SURFACES = ['cli', 'mcp', 'docs', 'dashboard', 'api'];
