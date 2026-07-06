import type { Command } from 'commander';
import { output } from '../../output/format.js';
import { ValidationError, ApiError } from '../../output/error.js';
import { addExamples } from '../../output/help.js';
import { resolveChannel } from '../channels.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { parseTimeArg } from './time.js';
import {
  fetchDeliveriesPage,
  fetchAllDeliveries,
  fetchDeliveryDetail,
  streamDeliveries,
  type DeliveriesPage,
  type DeliveryLog,
  type FetchDeliveriesParams,
} from './api.js';
import {
  renderDeliveryDetail,
  printSummaryRow,
} from './render.js';

interface ListOptions {
  limit?: string;
  since?: string;
  until?: string;
  cursor?: string;
  all?: boolean;
  follow?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** Validate `--limit` into the API's accepted `[1,100]` integer range. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ValidationError(
      `--limit must be an integer between 1 and 100 (got "${raw}").`,
    );
  }
  return n;
}

/**
 * Render a single delivery detail to stdout per the mode flags.
 * Modes:
 *   --json    → JSONL public delivery log, one event per line
 *   --verbose → full Meta payload + app response via renderDeliveryDetail
 *   default   → one-line summary via printSummaryRow (D9 table-by-default)
 */
function emitDelivery(
  detail: DeliveryLog,
  mode: { json: boolean; verbose: boolean },
): void {
  if (mode.json) {
    process.stdout.write(JSON.stringify(detail) + '\n');
  } else if (mode.verbose) {
    console.log(renderDeliveryDetail(detail, { verbose: true }));
  } else {
    printSummaryRow(detail);
  }
}

/**
 * `channels logs list` action. Three render modes (json/verbose/summary) and
 * two flow modes (paginated snapshot vs --follow live tail).
 *
 * Exported so tests can drive it directly without commander; the registered
 * action thin-wraps this.
 */
export async function runChannelLogsList(
  channelRef: string,
  opts: ListOptions,
  json: boolean,
): Promise<void> {
  const limit = parseLimit(opts.limit);
  const since = opts.since ? parseTimeArg(opts.since) : undefined;
  const until = opts.until ? parseTimeArg(opts.until) : undefined;
  const verbose = !!opts.verbose;
  const mode = { json, verbose };

  const channel = await resolveChannel(channelRef);

  // --follow: snapshot + live tail. The retention-floor note is non-applicable
  // here (we're tailing live events, not querying historical data).
  if (opts.follow) {
    const initial = await fetchDeliveriesPage({
      channelPublicId: channel.id,
      workspaceId: channel.workspaceId,
      limit,
      since,
      until,
      cursor: opts.cursor,
    });
    for (const log of initial.logs) {
      emitDelivery(log, mode);
    }
    for await (const detail of streamDeliveries({
      channelPublicId: channel.id,
      workspaceId: channel.workspaceId,
    })) {
      emitDelivery(detail, mode);
    }
    return;
  }

  const params: FetchDeliveriesParams = {
    channelPublicId: channel.id,
    workspaceId: channel.workspaceId,
    limit,
    since,
    until,
    cursor: opts.cursor,
  };

  const page: DeliveriesPage = opts.all
    ? await fetchAllDeliveries(params)
    : await fetchDeliveriesPage(params);

  if (json) {
    output(page.logs, { json: true });
    return;
  }

  if (page.logs.length === 0) {
    console.log('No delivery logs for this channel.');
    return;
  }

  if (verbose) {
    for (const log of page.logs) {
      console.log(renderDeliveryDetail(log, { verbose: true }));
    }
  } else {
    for (const log of page.logs) {
      printSummaryRow(log);
    }
  }

  if (page.nextCursor) {
    console.log('');
    console.log(`More deliveries available. Continue with: --cursor ${page.nextCursor}`);
  }
}

async function runChannelLogsShow(
  id: string,
  json: boolean,
  verbose: boolean,
): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  let detail;
  try {
    detail = await fetchDeliveryDetail(id, workspaceId);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      throw new ValidationError(
        `Delivery not found or outside the retention window: ${id}`,
      );
    }
    throw err;
  }

  if (json) {
    output(detail, { json: true });
    return;
  }
  console.log(renderDeliveryDetail(detail, { verbose }));
}

export function registerChannelsLogsCommand(
  channels: Command,
  program: Command,
): void {
  const logs = channels
    .command('logs')
    .description("Read a channel's webhook delivery history");

  const logsList = logs
    .command('list')
    .description('List recent webhook deliveries for a channel')
    .argument('<channel>', 'Channel ID (ch_xxxxxxxx) or display phone/name')
    .option('--limit <n>', 'Max rows per page (1-100, default 50)')
    .option('--since <time>', 'Only deliveries after this time (ISO-8601 or 30m/2h/7d)')
    .option('--until <time>', 'Only deliveries before this time (ISO-8601 or 30m/2h/7d)')
    .option('--cursor <cursor>', 'Continue from a previous page nextCursor')
    .option('--all', 'Auto-paginate every page (capped at 1000 rows)')
    .option('-f, --follow', 'Stream new deliveries as they arrive (Ctrl-C to stop)')
    .option('--json', 'JSON array of delivery logs ([] when empty; JSONL when --follow)')
    .option(
      '-v, --verbose',
      'Show the full Meta payload and app response',
    )
    .action(async (channelRef: string, opts: ListOptions) => {
      await runChannelLogsList(
        channelRef,
        opts,
        !!(opts.json || program.opts().json),
      );
    });

  const logsShow = logs
    .command('show')
    .description('Show the full detail of one delivery')
    .argument('<id>', 'Delivery ID for compatibility lookup')
    .option('--verbose', 'Show the full Meta payload and app response')
    .action(async (id: string, opts: { verbose?: boolean }) => {
      await runChannelLogsShow(id, !!program.opts().json, !!opts.verbose);
    });

  addExamples(
    logs,
    `
EXAMPLES:
  $ hookmyapp channels logs list ch_AAAAAAAA
  $ hookmyapp channels logs show 9b1f2e3d-4c5a-6789-0abc-def012345678
`,
  );
  addExamples(
    logsList,
    `
EXAMPLES:
  $ hookmyapp channels logs list ch_AAAAAAAA
  $ hookmyapp channels logs list ch_AAAAAAAA --since 24h --all --json
  $ hookmyapp channels logs list @ordvir --follow
  $ hookmyapp channels logs list +14155550100 --verbose
`,
  );
  addExamples(
    logsShow,
    `
EXAMPLES:
  $ hookmyapp channels logs show 9b1f2e3d-4c5a-6789-0abc-def012345678
  $ hookmyapp channels logs show 9b1f2e3d-4c5a-6789-0abc-def012345678 --json
`,
  );
}
