import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';

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

interface TicketDetail {
  ticketId: string;
  subject: string;
  status: string;
  messages: TicketMessage[];
  nextCursor: string;
  note?: string;
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

  const sReply = support
    .command('reply')
    .description('Send a follow-up on a ticket (replying to a resolved ticket reopens it)')
    .argument('<id>', 'Ticket id (sup_…)')
    .requiredOption('-m, --message <message>', 'Your follow-up message')
    .option('--wait <seconds>', 'Hold up to N seconds (1-25) for a support reply')
    .option('--after <cursor>', 'Opaque cursor from a previous response (nextCursor)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id: string, opts: { message: string; wait?: string; after?: string; json?: boolean }) => {
      assertTicketId(id);
      const body: Record<string, unknown> = { message: opts.message };
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
`,
  );
}
