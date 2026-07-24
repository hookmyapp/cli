import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn() }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_ig', type: 'instagram', metaResourceId: '17841400000000000', metaWabaId: null, workspaceId: 'ws_1' })) }));
vi.mock('../../output/format.js', () => ({ isJsonMode: vi.fn(() => false) }));
import { Command } from 'commander';
import { runInstagramInsights, registerInstagramInsights } from '../instagram-insights.js';
import { gatewayRequest } from '../../api/gateway.js';
import { resolveChannelRefOrDefault } from '../_helpers.js';
import { isJsonMode } from '../../output/format.js';
import { ValidationError, AuthError, NetworkError, ApiError } from '../../output/error.js';

const total = (name: string, value: number) => ({ data: [{ name, total_value: { value } }] });

/** Capture process.stdout.write; returns [getOutput, restore]. */
function captureStdout(): [() => string, () => void] {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
  return [() => writes.join(''), () => spy.mockRestore()];
}

describe('instagram insights', () => {
  beforeEach(() => {
    vi.mocked(gatewayRequest).mockReset();
    vi.mocked(resolveChannelRefOrDefault).mockClear();
    vi.mocked(isJsonMode).mockReturnValue(false);
  });

  it('account: fetches each default metric separately with period=day&metric_type=total_value', async () => {
    vi.mocked(gatewayRequest).mockImplementation(async ({ path }) => {
      const m = /metric=([a-z_]+)/.exec(path as string)![1];
      return total(m, 42);
    });
    await runInstagramInsights({ channel: '@acme' });
    expect(resolveChannelRefOrDefault).toHaveBeenCalledWith('@acme', 'instagram');
    const paths = vi.mocked(gatewayRequest).mock.calls.map((c) => c[0].path);
    expect(paths).toEqual([
      '/{ig_id}/insights?metric=reach&period=day&metric_type=total_value',
      '/{ig_id}/insights?metric=views&period=day&metric_type=total_value',
      '/{ig_id}/insights?metric=total_interactions&period=day&metric_type=total_value',
      '/{ig_id}/insights?metric=accounts_engaged&period=day&metric_type=total_value',
    ]);
  });

  it('--media fetches media insights per metric without period', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [{ values: [{ value: 7 }] }] });
    await runInstagramInsights({ channel: '@acme', media: '178090', metrics: 'reach,views' });
    const paths = vi.mocked(gatewayRequest).mock.calls.map((c) => c[0].path);
    expect(paths).toEqual(['/178090/insights?metric=reach', '/178090/insights?metric=views']);
  });

  it('a Meta-rejected metric is skipped, listed at the end, and the call still resolves (exit 0)', async () => {
    const [out, restore] = captureStdout();
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce(total('reach', 42))
      .mockRejectedValueOnce(new ValidationError('(#10) Not enough viewers', 'META_REJECTED'))
      .mockResolvedValueOnce(total('total_interactions', 3))
      .mockResolvedValueOnce(total('accounts_engaged', 2));
    await expect(runInstagramInsights({ channel: '@acme' })).resolves.toBeUndefined();
    restore();
    expect(out()).toContain('reach\t42');
    expect(out()).toContain('Unavailable: views');
  });

  it('an empty data array means unavailable, not a null value (human output)', async () => {
    const [out, restore] = captureStdout();
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce(total('reach', 42))
      .mockResolvedValueOnce({ data: [] })                       // views: nothing recorded
      .mockResolvedValueOnce(total('total_interactions', 3))
      .mockResolvedValueOnce(total('accounts_engaged', 2));
    await runInstagramInsights({ channel: '@acme' });
    restore();
    expect(out()).not.toContain('views\t');
    expect(out()).toContain('Unavailable: views');
  });

  it('--json omits empty-data metrics from metrics and lists them unavailable', async () => {
    vi.mocked(isJsonMode).mockReturnValue(true);
    const [out, restore] = captureStdout();
    vi.mocked(gatewayRequest)
      .mockResolvedValueOnce(total('reach', 42))
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce(total('total_interactions', 3))
      .mockResolvedValueOnce(total('accounts_engaged', 2));
    await runInstagramInsights({ channel: '@acme' }, {} as Command);
    restore();
    expect(JSON.parse(out())).toEqual({
      target: 'account',
      metrics: { reach: 42, total_interactions: 3, accounts_engaged: 2 },
      unavailable: ['views'],
    });
  });

  it.each([
    ['AuthError', new AuthError()],
    ['NetworkError', new NetworkError()],
    ['ApiError (gateway 5xx)', new ApiError('Meta gateway error (500).', 500)],
  ])('%s is rethrown, never folded into unavailable', async (_name, err) => {
    vi.mocked(gatewayRequest).mockRejectedValue(err);
    await expect(runInstagramInsights({ channel: '@acme' })).rejects.toBe(err);
  });

  it('rejects an empty --metrics list', async () => {
    await expect(runInstagramInsights({ channel: '@acme', metrics: ' , ' })).rejects.toThrow(/--metrics/);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric --media id without calling the gateway', async () => {
    await expect(runInstagramInsights({ channel: '@acme', media: 'abc/../x' })).rejects.toThrow(/numeric/i);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('throws the Meta rejection when EVERY metric is rejected (target-level failure, not unavailable)', async () => {
    const err = new ValidationError('Unsupported get request. Object does not exist', 'META_REJECTED');
    vi.mocked(gatewayRequest).mockRejectedValue(err);
    await expect(runInstagramInsights({ channel: '@acme', media: '178090', metrics: 'reach,views' })).rejects.toBe(err);
  });

  it('rejects a malformed metric name without calling the gateway', async () => {
    await expect(runInstagramInsights({ channel: '@acme', metrics: 'reach,bad&metric' })).rejects.toThrow(/metric/i);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('registers the insights subcommand with examples', () => {
    const instagram = new Command('instagram');
    registerInstagramInsights(instagram);
    const insights = instagram.commands.find((c) => c.name() === 'insights');
    expect(insights).toBeDefined();
    expect(insights!.helpInformation()).toContain('EXAMPLES:');
  });
});
