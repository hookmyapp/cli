import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { assertFbId } from './facebook-ids.js';

// Same defaults as the get_facebook_insights MCP tool.
export const PAGE_DEFAULT_METRICS = ['page_post_engagements', 'page_follows', 'page_views_total', 'page_daily_follows_unique'];
export const POST_DEFAULT_METRICS = ['post_clicks', 'post_reactions_by_type_total', 'post_activity_by_action_type'];
const PERIODS = ['day', 'week', 'days_28'];
const METRIC_NAME_RE = /^[a-z0-9_]+$/i;

export interface FbInsightsOpts {
  channel?: string;
  post?: string;
  metric?: string[];
  period?: string;
}

export async function runFacebookInsights(opts: FbInsightsOpts, cmd?: Command): Promise<void> {
  const post = opts.post ? assertFbId(opts.post, 'post', '--post') : undefined;
  const metrics = opts.metric?.length ? opts.metric : post ? POST_DEFAULT_METRICS : PAGE_DEFAULT_METRICS;
  for (const m of metrics) {
    if (!METRIC_NAME_RE.test(m)) throw new ValidationError(`Invalid metric name: ${JSON.stringify(m)}.`, 'INSIGHTS_BAD_METRIC');
  }
  if (opts.period !== undefined && !PERIODS.includes(opts.period)) {
    throw new ValidationError(`--period must be one of ${PERIODS.join(', ')} (got: ${opts.period}).`, 'INSIGHTS_BAD_PERIOD');
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'facebook');
  const params = new URLSearchParams({ metric: metrics.join(','), ...(post ? {} : { period: opts.period ?? 'day' }) });
  const res = await gatewayRequest({ channel, method: 'GET', path: `${post ? `/${post}` : '/{page_id}'}/insights?${params.toString()}` });
  const rows = (res?.data ?? []) as Array<{ name?: string; period?: string; values?: Array<{ value?: unknown; end_time?: string }> }>;
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(JSON.stringify({ target: post ?? 'page', metrics: rows }) + '\n');
    return;
  }
  for (const row of rows) {
    const last = row.values?.at(-1);
    const value = last?.value === undefined ? '(no data)' : typeof last.value === 'object' ? JSON.stringify(last.value) : String(last.value);
    process.stdout.write(`${row.name ?? ''}\t${row.period ?? ''}\t${value}\n`);
  }
  if (rows.length === 0) process.stdout.write('No insights returned.\n');
}

/** Registers `facebook insights`. */
export function registerFacebookInsights(facebook: Command): void {
  const insights = facebook
    .command('insights')
    .description('Read Page insights, or one post\'s insights with --post')
    .option('--channel <ref>', 'Channel: ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--post <id>', 'Post id ({pageId}_{postId}) for post insights')
    .option('--metric <name...>', `Metric names (Page default: ${PAGE_DEFAULT_METRICS.join(', ')})`)
    .option('--period <period>', 'Page metrics period: day, week, days_28 (default day)')
    .action(async function (this: Command, opts: FbInsightsOpts) {
      await runFacebookInsights(opts, this);
    });

  addExamples(
    insights,
    `
EXAMPLES:
  $ hookmyapp facebook insights --channel ch_XXXXXXXX
  $ hookmyapp facebook insights --channel ch_XXXXXXXX --metric page_follows page_views_total --period week --json
  $ hookmyapp facebook insights --channel ch_XXXXXXXX --post <page-id>_<post-id>
`,
  );
}
