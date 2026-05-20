import type { Command } from 'commander';
import { output } from '../../output/format.js';
import { ValidationError } from '../../output/error.js';
import { addExamples } from '../../output/help.js';
import { resolveChannel } from '../channels.js';
import { parseTimeArg } from './time.js';
import {
  fetchDeliveriesPage,
  fetchAllDeliveries,
  type DeliveriesPage,
  type FetchDeliveriesParams,
} from './api.js';
import { toListRows } from './render.js';

interface ListOptions {
  limit?: string;
  since?: string;
  until?: string;
  cursor?: string;
  all?: boolean;
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

async function runChannelLogsList(
  channelRef: string,
  opts: ListOptions,
  json: boolean,
): Promise<void> {
  const limit = parseLimit(opts.limit);
  const since = opts.since ? parseTimeArg(opts.since) : undefined;
  const until = opts.until ? parseTimeArg(opts.until) : undefined;

  const channel = await resolveChannel(channelRef);
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
    output(page, { json: true });
    return;
  }

  if (page.deliveries.length === 0) {
    console.log(`No deliveries in the last ${page.floorHours}h for this channel.`);
    return;
  }

  // Retention-floor note — only when an explicit --since was clamped (spec D9).
  if (since) {
    const floorBoundaryMs = Date.now() - page.floorHours * 3_600_000;
    if (new Date(since).getTime() < floorBoundaryMs) {
      console.log(`Showing last ${page.floorHours}h (plan retention limit).`);
    }
  }

  output(toListRows(page.deliveries), { human: true });

  if (page.nextCursor) {
    console.log('');
    console.log(`More deliveries available. Continue with: --cursor ${page.nextCursor}`);
  }
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
    .action(async (channelRef: string, opts: ListOptions) => {
      await runChannelLogsList(channelRef, opts, !!program.opts().json);
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
`,
  );
}
