import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  apiClient: vi.fn(),
  resolveChannel: vi.fn(),
  getDefaultWorkspaceId: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  apiClient: mocks.apiClient,
  setWorkspaceContext: vi.fn(),
}));
vi.mock('../../commands/channels.js', () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock('../../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: mocks.getDefaultWorkspaceId,
}));

import { registerChannelsLogsCommand } from '../../commands/channels-logs/index.js';
import { ValidationError } from '../../output/error.js';
import type { DeliveryLog } from '../../commands/channels-logs/api.js';

function deliveryLog(overrides: Partial<DeliveryLog> = {}): DeliveryLog {
  return {
    publicId: 'wd_u9uElygL',
    receivedAt: new Date().toISOString(),
    sender: '+14155550100',
    messageId: 'wamid.test',
    meta: { text: 'hi' },
    hookmyapp: {
      status: 'delivered',
      statusText: 'Delivered to your app',
      destination: { type: 'webhook', url: 'https://customer.app/webhook' },
      appResponse: { status: 200, durationMs: 100, body: null },
    },
    ...overrides,
  };
}

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'json');
  const channels = program.command('channels');
  registerChannelsLogsCommand(channels, program);
  await program.parseAsync(['node', 'hookmyapp', 'channels', ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveChannel.mockResolvedValue({ id: 'ch_abc12345', workspaceId: 'ws_w1' });
  mocks.getDefaultWorkspaceId.mockResolvedValue('ws_w1');
});

describe('channels logs list', () => {
  it('prints one summary row per delivery in default mode (D9 — table-by-default)', async () => {
    mocks.apiClient.mockResolvedValueOnce({
      logs: [deliveryLog(), deliveryLog({ messageId: 'wamid.two' })],
      nextCursor: null,
    });
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await run(['logs', 'list', 'ch_abc12345']);

    const combined = writes.join('');
    expect(combined).toContain('wd_u9uElygL');
    expect(combined).toContain('+14155550100');
    expect(combined).toContain('Delivered to your app');
    expect(combined).toContain('text');
    expect(combined).toContain('hi');
    // Two summary rows were emitted.
    expect(writes.filter((w) => w.includes('Delivered to your app'))).toHaveLength(2);
    expect(mocks.apiClient).toHaveBeenCalledTimes(1);
  });

  it('emits a single JSON array of public delivery logs under --json', async () => {
    const log = deliveryLog({
      receivedAt: '2026-05-20T11:58:00.000Z',
      meta: { hello: 'world' },
    });
    mocks.apiClient.mockResolvedValueOnce({
      logs: [log],
      nextCursor: 'c1',
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    await run(['logs', 'list', 'ch_abc12345', '--json']);

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].publicId).toBe('wd_u9uElygL');
    expect(parsed[0].sender).toBe('+14155550100');
    expect(parsed[0].meta).toEqual({ hello: 'world' });
    expect(parsed[0].hookmyapp.statusText).toBe('Delivered to your app');
    expect(parsed[0].routingDecision).toBeUndefined();
    expect(parsed[0].signatureOk).toBeUndefined();
    expect(parsed[0].requestId).toBeUndefined();
  });

  it('emits [] under --json when there are no deliveries', async () => {
    mocks.apiClient.mockResolvedValueOnce({
      logs: [],
      nextCursor: null,
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    await run(['logs', 'list', 'ch_abc12345', '--json']);

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual([]);
  });

  it('prints a friendly message when there are no deliveries', async () => {
    mocks.apiClient.mockResolvedValue({ logs: [], nextCursor: null });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain(
      'No delivery logs for this channel.',
    );
    log.mockRestore();
  });

  it('auto-paginates every page under --all', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({ logs: [deliveryLog({ messageId: 'p1' })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ logs: [deliveryLog({ messageId: 'p2' })], nextCursor: null });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['logs', 'list', 'ch_abc12345', '--all']);

    // Two list-page calls confirm pagination followed nextCursor.
    const listCalls = mocks.apiClient.mock.calls.filter(([path]) =>
      String(path).startsWith('/deliveries?'),
    );
    expect(listCalls).toHaveLength(2);
  });

  it('rejects an out-of-range --limit', async () => {
    await expect(run(['logs', 'list', 'ch_abc12345', '--limit', '999'])).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an unparseable --since', async () => {
    await expect(
      run(['logs', 'list', 'ch_abc12345', '--since', 'yesterday']),
    ).rejects.toThrow(ValidationError);
  });

  it('prints a continuation hint when nextCursor is non-null', async () => {
    mocks.apiClient.mockResolvedValueOnce({
      logs: [deliveryLog()],
      nextCursor: 'tok_abc',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain('--cursor tok_abc');
    log.mockRestore();
  });

  it('forwards --until and --cursor through to the API query', async () => {
    mocks.apiClient.mockResolvedValue({ logs: [], nextCursor: null });

    await run(['logs', 'list', 'ch_abc12345', '--until', '1h', '--cursor', 'tok_xyz']);

    const listCall = mocks.apiClient.mock.calls.find(([path]) =>
      String(path).startsWith('/deliveries?'),
    );
    expect(listCall).toBeDefined();
    const [path] = listCall as [string, unknown];
    expect(path).toContain('until=');
    expect(path).toContain('cursor=tok_xyz');
  });
});
