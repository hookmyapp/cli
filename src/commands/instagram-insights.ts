import type { Command } from 'commander';
import { addExamples } from '../output/help.js';
import { gatewayRequest } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

const DEFAULT_ACCOUNT_METRICS = 'reach,views,total_interactions,accounts_engaged';
const DEFAULT_MEDIA_METRICS = 'reach,views,total_interactions,saved';
// Shape-only validation; Meta's evolving metric list is deliberately NOT mirrored here —
// a well-formed unknown metric surfaces as a Meta rejection → unavailable.
const METRIC_NAME_RE = /^[a-z0-9_]+$/i;
// Meta media ids are numeric Graph object ids — anything else can smuggle path
// segments into the route and would only surface as a confusing per-metric rejection.
const IG_MEDIA_ID_RE = /^\d+$/;

export interface IgInsightsOpts {
  channel?: string;
  media?: string;
  metrics?: string;
}

export async function runInstagramInsights(opts: IgInsightsOpts, cmd?: Command): Promise<void> {
  const metrics = (opts.metrics ?? (opts.media ? DEFAULT_MEDIA_METRICS : DEFAULT_ACCOUNT_METRICS))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (metrics.length === 0) {
    throw new ValidationError('--metrics needs at least one metric name.', 'INSIGHTS_NO_METRICS');
  }
  for (const metric of metrics) {
    if (!METRIC_NAME_RE.test(metric)) {
      throw new ValidationError(`Invalid metric name: ${JSON.stringify(metric)}.`, 'INSIGHTS_BAD_METRIC');
    }
  }
  if (opts.media && !IG_MEDIA_ID_RE.test(opts.media)) {
    throw new ValidationError(`--media must be a numeric Instagram media id (got: ${opts.media}).`, 'INSIGHTS_BAD_MEDIA_ID');
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'instagram');
  const values: Record<string, number | null> = {};
  const unavailable: string[] = [];
  let firstRejection: ValidationError | null = null;
  // Per-metric isolation (spec §Error handling): one Meta-rejected metric never fails the whole call.
  for (const metric of metrics) {
    const params = new URLSearchParams(
      opts.media ? { metric } : { metric, period: 'day', metric_type: 'total_value' },
    );
    const path = `${opts.media ? `/${opts.media}` : '/{ig_id}'}/insights?${params.toString()}`;
    try {
      const res = await gatewayRequest({ channel, method: 'GET', path });
      const d = res?.data?.[0];
      if (!d) {
        // Meta returns an empty data array when nothing is recorded — that metric is unavailable.
        unavailable.push(metric);
        continue;
      }
      values[metric] = d.total_value?.value ?? d.values?.at(-1)?.value ?? null;
    } catch (err) {
      // Isolate ONLY metric-level Meta rejections (mapGatewayError → ValidationError/META_REJECTED;
      // numeric codes like 10 are not preserved). AuthError, NetworkError, ApiError (5xx), backend
      // reconnect-required / unsupported-login-flow, other ValidationErrors (e.g. an unresolvable
      // {ig_id} placeholder), and unknown errors abort the whole command.
      if (err instanceof ValidationError && err.code === 'META_REJECTED') {
        unavailable.push(metric);
        firstRejection ??= err;
      } else {
        throw err;
      }
    }
  }
  // Every metric Meta-rejected and none resolved or came back empty: that is a
  // target-level failure (bad media id, inaccessible account), not N unavailable
  // metrics — surface the real error instead of an empty success.
  if (firstRejection && Object.keys(values).length === 0 && unavailable.length === metrics.length) {
    throw firstRejection;
  }
  if (cmd && isJsonMode(cmd)) {
    process.stdout.write(
      JSON.stringify({ target: opts.media ?? 'account', metrics: values, unavailable }) + '\n',
    );
    return;
  }
  for (const [metric, value] of Object.entries(values)) {
    process.stdout.write(`${metric}\t${value ?? '(no data)'}\n`);
  }
  if (unavailable.length > 0) {
    process.stdout.write(`Unavailable: ${unavailable.join(', ')}\n`);
  }
}

/** Registers `instagram insights`. */
export function registerInstagramInsights(instagram: Command): void {
  const insights = instagram
    .command('insights')
    .description('Read account or media insights')
    .option('--channel <ref>', 'Channel: @handle or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)')
    .option('--media <id>', 'Instagram media id (media insights instead of account)')
    .option('--metrics <list>', `Comma-separated metrics (account default: ${DEFAULT_ACCOUNT_METRICS})`)
    .action(async function (this: Command, opts: IgInsightsOpts) {
      await runInstagramInsights(opts, this);
    });

  addExamples(
    insights,
    `
EXAMPLES:
  $ hookmyapp instagram insights --channel @acme
  $ hookmyapp instagram insights --channel @acme --metrics reach,views --json
  $ hookmyapp instagram insights --channel @acme --media <ig-media-id>
`,
  );
}
