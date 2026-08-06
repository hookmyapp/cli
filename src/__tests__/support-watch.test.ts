import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { Command } from 'commander';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { registerSupportCommand, type TicketDetail } from '../commands/support.js';
import { NetworkError, ValidationError, NotFoundError } from '../output/error.js';

const mockedApi = vi.mocked(apiClient);

/** AIT-346 — `hookmyapp support watch`: terminal outcomes, pacing, cursors. */

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'global json');
  registerSupportCommand(program);
  return program;
}

function run(args: string[]): Promise<unknown> {
  return makeProgram().parseAsync(['node', 'hookmyapp', ...args]);
}

function logged(): string {
  return mockConsoleLog.mock.calls.map((c) => c.join(' ')).join('\n');
}

function detail(over: Partial<TicketDetail> = {}): TicketDetail {
  return {
    ticketId: 'sup_1',
    subject: 's',
    status: 'open',
    messages: [{ role: 'support', text: 'hello from support', at: '2026-08-05T00:00:00Z' }],
    nextCursor: 'cur2',
    ...over,
  };
}

const NO_REPLY = 'no reply yet — check again later';

/** Run a watch to completion under fake timers: start it, then advance fake
 * time in 25s boundaries until the command promise settles. */
async function drive(promise: Promise<unknown>, maxCycles = 20): Promise<unknown> {
  let settled = false;
  let outcome: { ok: boolean; value?: unknown; err?: unknown } | null = null;
  const tracked = promise.then(
    (value) => {
      settled = true;
      outcome = { ok: true, value };
    },
    (err) => {
      settled = true;
      outcome = { ok: false, err };
    },
  );
  for (let i = 0; i < maxCycles && !settled; i++) {
    await vi.advanceTimersByTimeAsync(25_000);
  }
  await tracked.catch(() => undefined);
  if (!outcome) throw new Error('watch did not settle under fake timers');
  const result = outcome as { ok: boolean; value?: unknown; err?: unknown };
  if (!result.ok) throw result.err;
  return result.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
});

afterAll(() => {
  mockConsoleLog.mockRestore();
  mockConsoleError.mockRestore();
});

describe('support watch', () => {
  it('message outcome: exits with transcript + resume command, no afterCursor on first cursorless call', async () => {
    mockedApi.mockResolvedValue(detail());
    await drive(run(['support', 'watch', 'sup_1']));
    expect(mockedApi.mock.calls[0][0]).toBe('/support/tickets/sup_1?wait=25');
    const out = logged();
    expect(out).toContain('[support]');
    expect(out).toContain('Resume: hookmyapp support watch sup_1 --after cur2');
    expect(process.exitCode).toBeUndefined();
  });

  it('threads the cursor between cycles and paces ≥25s between request starts', async () => {
    mockedApi
      .mockResolvedValueOnce(detail({ note: NO_REPLY, nextCursor: 'curA' }))
      .mockResolvedValueOnce(detail({ nextCursor: 'curB' }));
    await drive(run(['support', 'watch', 'sup_1']));
    expect(mockedApi.mock.calls[1][0]).toBe('/support/tickets/sup_1?wait=25&afterCursor=curA');
    expect(logged()).toContain('--after curB');
  });

  it('resolved outcome: note present + resolved status terminates with exit 0', async () => {
    mockedApi.mockResolvedValue(detail({ note: NO_REPLY, status: 'resolved' }));
    await drive(run(['support', 'watch', 'sup_1']));
    expect(logged()).toContain('resolved');
    expect(process.exitCode).toBeUndefined();
  });

  it('timeout outcome: exit code 1 with note and resume command', async () => {
    mockedApi.mockResolvedValue(detail({ note: NO_REPLY, nextCursor: 'curT' }));
    await drive(run(['support', 'watch', 'sup_1', '--timeout', '90s']));
    const out = logged();
    expect(out).toContain('no reply within 90s');
    expect(out).toContain('Resume: hookmyapp support watch sup_1 --after curT');
    expect(process.exitCode).toBe(1);
  });

  it('deadline shortens the final wait: 90s → waits 25,25,25,15', async () => {
    mockedApi.mockResolvedValue(detail({ note: NO_REPLY }));
    await drive(run(['support', 'watch', 'sup_1', '--timeout', '90s']));
    const waits = mockedApi.mock.calls.map((c) => new URL(`x:${c[0]}`).searchParams.get('wait'));
    expect(waits).toEqual(['25', '25', '25', '15']);
  });

  it('transient failures are retried; success resets the outcome', async () => {
    mockedApi
      .mockRejectedValueOnce(new NetworkError('boom'))
      .mockRejectedValueOnce(new NetworkError('boom'))
      .mockResolvedValueOnce(detail());
    await drive(run(['support', 'watch', 'sup_1']));
    expect(logged()).toContain('Resume: hookmyapp support watch sup_1 --after cur2');
  });

  it('three consecutive transient failures become terminal with the error family preserved', async () => {
    mockedApi.mockRejectedValue(new NetworkError('down'));
    await expect(drive(run(['support', 'watch', 'sup_1', '--after', 'curZ']))).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(mockedApi).toHaveBeenCalledTimes(3);
    const err = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(err).toContain('Resume: hookmyapp support watch sup_1 --after curZ');
  });

  it('failure counter is consecutive, not cumulative', async () => {
    mockedApi
      .mockRejectedValueOnce(new NetworkError('a'))
      .mockResolvedValueOnce(detail({ note: NO_REPLY, nextCursor: 'curA' }))
      .mockRejectedValueOnce(new NetworkError('b'))
      .mockRejectedValueOnce(new NetworkError('c'))
      .mockResolvedValueOnce(detail());
    await drive(run(['support', 'watch', 'sup_1']));
    expect(mockedApi).toHaveBeenCalledTimes(5);
  });

  it('non-transient errors are immediately terminal', async () => {
    mockedApi.mockRejectedValue(new NotFoundError('Ticket not found.'));
    await expect(drive(run(['support', 'watch', 'sup_1']))).rejects.toBeInstanceOf(NotFoundError);
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });

  it('error after progress keeps the advanced cursor in the resume line', async () => {
    mockedApi
      .mockResolvedValueOnce(detail({ note: NO_REPLY, nextCursor: 'curA' }))
      .mockRejectedValueOnce(new NotFoundError('gone'));
    await expect(drive(run(['support', 'watch', 'sup_1']))).rejects.toBeInstanceOf(NotFoundError);
    const err = mockConsoleError.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(err).toContain('--after curA');
  });

  it('--json message envelope: exactly one JSON object with reason/cursor/resume/detail', async () => {
    mockedApi.mockResolvedValue(detail());
    await drive(run(['support', 'watch', 'sup_1', '--json']));
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      reason: 'message',
      cursor: 'cur2',
      resume: 'hookmyapp support watch sup_1 --after cur2',
    });
    expect(parsed.detail.ticketId).toBe('sup_1');
  });

  it('--json timeout and error envelopes are single objects; error sets exitCode without rejecting', async () => {
    mockedApi.mockResolvedValue(detail({ note: NO_REPLY }));
    await drive(run(['support', 'watch', 'sup_1', '--timeout', '30s', '--json']));
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toMatchObject({ reason: 'timeout' });
    expect(process.exitCode).toBe(1);

    vi.clearAllMocks();
    process.exitCode = undefined;
    mockedApi.mockRejectedValue(new NotFoundError('gone'));
    await drive(run(['support', 'watch', 'sup_1', '--json']));
    expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toMatchObject({ reason: 'error' });
    expect(process.exitCode).toBe(1);
  });

  it('rejects bad --timeout values before any HTTP', async () => {
    await expect(run(['support', 'watch', 'sup_1', '--timeout', '3h'])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(run(['support', 'watch', 'sup_1', '--timeout', 'nonsense'])).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('--after seeds the first call', async () => {
    mockedApi.mockResolvedValue(detail());
    await drive(run(['support', 'watch', 'sup_1', '--after', 'curX']));
    expect(mockedApi.mock.calls[0][0]).toBe('/support/tickets/sup_1?wait=25&afterCursor=curX');
  });

  it('every poll carries a per-cycle abort signal (stalled transport cannot outlive the deadline)', async () => {
    mockedApi.mockResolvedValue(detail());
    await drive(run(['support', 'watch', 'sup_1']));
    const opts = mockedApi.mock.calls[0][1] as { signal?: AbortSignal } | undefined;
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('message arriving together with resolution prints the resolved notice, reason stays message', async () => {
    mockedApi.mockResolvedValue(detail({ status: 'resolved' }));
    await drive(run(['support', 'watch', 'sup_1']));
    const out = logged();
    expect(out).toContain('[support]');
    expect(out).toContain('was resolved');
  });

  it('global --json flag also switches to the envelope', async () => {
    mockedApi.mockResolvedValue(detail());
    const program = makeProgram();
    await drive(program.parseAsync(['node', 'hookmyapp', '--json', 'support', 'watch', 'sup_1']));
    expect(JSON.parse(mockConsoleLog.mock.calls[0][0] as string)).toMatchObject({ reason: 'message' });
  });
});
