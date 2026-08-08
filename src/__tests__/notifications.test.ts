import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

vi.mock('../notices-nudge.js', () => ({
  recordNoticesSnapshot: vi.fn(),
}));

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { recordNoticesSnapshot } from '../notices-nudge.js';
import { registerNotificationsCommand } from '../commands/notifications.js';

const mockedApi = vi.mocked(apiClient);

/** AIT-358 — `hookmyapp notifications list|ack` wire contract. */

const NOTICE = {
  id: 'ntc_A1b2C3d4',
  severity: 'error',
  scope: 'channel',
  workspaceId: 'ws_11111111',
  channelId: 'ch_22222222',
  title: 'Webhook delivery to your endpoint is failing',
  body: 'We have hit 150 consecutive failures delivering webhooks.',
  createdAt: '2026-08-08T00:00:00.000Z',
};

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'global json');
  registerNotificationsCommand(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await makeProgram().parseAsync(['node', 'hookmyapp', ...args]);
}

function logged(): string {
  return mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  mockConsoleLog.mockRestore();
});

describe('notifications list', () => {
  it('GETs /notices and renders ID/SEVERITY/TITLE/CREATED plus the body', async () => {
    mockedApi.mockResolvedValue({ notices: [NOTICE] });
    await run(['notifications', 'list']);
    expect(mockedApi).toHaveBeenCalledWith('/notices');
    const out = logged();
    for (const col of ['ID', 'SEVERITY', 'TITLE', 'CREATED']) expect(out).toContain(col);
    expect(out).toContain('ntc_A1b2C3d4');
    expect(out).toContain('150 consecutive failures');
  });

  it('is the default subcommand — bare `notifications` lists', async () => {
    mockedApi.mockResolvedValue({ notices: [] });
    await run(['notifications']);
    expect(mockedApi).toHaveBeenCalledWith('/notices');
  });

  it('--all includes acknowledged notices', async () => {
    mockedApi.mockResolvedValue({ notices: [] });
    await run(['notifications', 'list', '--all']);
    expect(mockedApi).toHaveBeenCalledWith('/notices?all=true');
  });

  it('empty state prints the all-clear line', async () => {
    mockedApi.mockResolvedValue({ notices: [] });
    await run(['notifications', 'list']);
    expect(logged()).toContain('No open notices. All clear.');
  });

  it('--json prints the raw notices array', async () => {
    mockedApi.mockResolvedValue({ notices: [NOTICE] });
    await run(['notifications', 'list', '--json']);
    expect(JSON.parse(mockConsoleLog.mock.calls.at(-1)![0] as string)).toEqual([NOTICE]);
  });

  it('rewrites the nudge cache from the real response (unread count)', async () => {
    mockedApi.mockResolvedValue({
      notices: [NOTICE, { ...NOTICE, id: 'ntc_B2c3D4e5', acknowledgedAt: '2026-08-08T01:00:00.000Z' }],
    });
    await run(['notifications', 'list', '--all']);
    expect(vi.mocked(recordNoticesSnapshot)).toHaveBeenCalledWith(1);
  });
});

describe('notifications ack', () => {
  it('POSTs to /notices/:id/ack, confirms, and rewrites the cache from a fresh list', async () => {
    mockedApi
      .mockResolvedValueOnce({ notice: { ...NOTICE, acknowledgedAt: '2026-08-08T02:00:00.000Z' } })
      .mockResolvedValueOnce({ notices: [] });
    await run(['notifications', 'ack', 'ntc_A1b2C3d4']);
    expect(mockedApi).toHaveBeenNthCalledWith(1, '/notices/ntc_A1b2C3d4/ack', { method: 'POST' });
    expect(mockedApi).toHaveBeenNthCalledWith(2, '/notices');
    expect(logged()).toContain('Acknowledged ntc_A1b2C3d4.');
    expect(vi.mocked(recordNoticesSnapshot)).toHaveBeenCalledWith(0);
  });

  it('re-acking an already-acked id keeps the cache honest while another notice is unread', async () => {
    // Regression (PR #49 review): ack is idempotent — a duplicate ack must
    // not zero the unread cache; the refetch is the source of truth.
    mockedApi
      .mockResolvedValueOnce({ notice: { ...NOTICE, acknowledgedAt: '2026-08-08T02:00:00.000Z' } })
      .mockResolvedValueOnce({ notices: [{ ...NOTICE, id: 'ntc_Zz9Yy8Xx' }] });
    await run(['notifications', 'ack', 'ntc_A1b2C3d4']);
    expect(vi.mocked(recordNoticesSnapshot)).toHaveBeenCalledWith(1);
  });

  it('a failed cache refetch never fails the (already successful) ack', async () => {
    mockedApi
      .mockResolvedValueOnce({ notice: { ...NOTICE, acknowledgedAt: '2026-08-08T02:00:00.000Z' } })
      .mockRejectedValueOnce(new Error('network down'));
    await run(['notifications', 'ack', 'ntc_A1b2C3d4']);
    expect(logged()).toContain('Acknowledged ntc_A1b2C3d4.');
    expect(vi.mocked(recordNoticesSnapshot)).not.toHaveBeenCalled();
  });

  it('validates the notice id locally — no HTTP on garbage', async () => {
    await expect(run(['notifications', 'ack', 'bogus'])).rejects.toThrow(/Invalid notice id/);
    await expect(run(['notifications', 'ack', 'ntc_toolongtobevalid'])).rejects.toThrow(/Invalid notice id/);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('--json prints the acked notice envelope', async () => {
    const acked = { notice: { ...NOTICE, acknowledgedAt: '2026-08-08T02:00:00.000Z' } };
    mockedApi.mockResolvedValue(acked);
    await run(['notifications', 'ack', 'ntc_A1b2C3d4', '--json']);
    expect(JSON.parse(mockConsoleLog.mock.calls.at(-1)![0] as string)).toEqual(acked);
  });
});
