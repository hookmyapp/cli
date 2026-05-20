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

function listItem(id: string) {
  return {
    id,
    receivedAt: new Date().toISOString(),
    fromPhone: '+14155550100',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusColor: 'green',
    latestAttempt: { outcome: 'delivered', forwardStatus: 200, attemptedAt: new Date().toISOString() },
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
  it('prints a table of deliveries for the channel', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [listItem('row-aaa'), listItem('row-bbb')],
      nextCursor: null,
      floorHours: 168,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('row-aaa');
    expect(out).toContain('row-bbb');
    log.mockRestore();
  });

  it('emits the raw API page verbatim under --json', async () => {
    const page = { deliveries: [listItem('row-aaa')], nextCursor: 'c1', floorHours: 24 };
    mocks.apiClient.mockResolvedValue(page);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345', '--json']);

    expect(log).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
    log.mockRestore();
  });

  it('prints a friendly message when there are no deliveries', async () => {
    mocks.apiClient.mockResolvedValue({ deliveries: [], nextCursor: null, floorHours: 24 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain(
      'No deliveries in the last 24h for this channel.',
    );
    log.mockRestore();
  });

  it('auto-paginates every page under --all', async () => {
    mocks.apiClient
      .mockResolvedValueOnce({ deliveries: [listItem('p1')], nextCursor: 'c1', floorHours: 168 })
      .mockResolvedValueOnce({ deliveries: [listItem('p2')], nextCursor: null, floorHours: 168 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345', '--all']);

    expect(mocks.apiClient).toHaveBeenCalledTimes(2);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('p1');
    expect(out).toContain('p2');
    log.mockRestore();
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

  it('prints a retention-floor note when --since predates the floor', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [listItem('row-x')],
      nextCursor: null,
      floorHours: 168,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345', '--since', '720h']);

    expect(log.mock.calls.flat().join('\n')).toContain('Showing last 168h');
    log.mockRestore();
  });

  it('prints a continuation hint when nextCursor is non-null', async () => {
    mocks.apiClient.mockResolvedValue({
      deliveries: [listItem('row-x')],
      nextCursor: 'tok_abc',
      floorHours: 168,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['logs', 'list', 'ch_abc12345']);

    expect(log.mock.calls.flat().join('\n')).toContain('--cursor tok_abc');
    log.mockRestore();
  });
});
