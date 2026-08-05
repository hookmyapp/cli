import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { registerSupportCommand } from '../commands/support.js';

const mockedApi = vi.mocked(apiClient);

/** AIT-337 — `hookmyapp support new|list|show|reply` wire contract. */

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json', 'global json');
  registerSupportCommand(program);
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

describe('support new', () => {
  it('POSTs subject + -m body as JSON and prints the ticket id', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_7', status: 'open' });
    await run(['support', 'new', '--subject', 'send fails', '-m', 'HTTP 500 from send_message']);
    expect(mockedApi).toHaveBeenCalledWith('/support/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject: 'send fails', description: 'HTTP 500 from send_message' }),
    });
    expect(logged()).toContain('sup_7');
    expect(logged()).toContain('hookmyapp support show sup_7');
  });

  it('--json prints raw JSON', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_7', status: 'open' });
    await run(['support', 'new', '--subject', 's', '-m', 'd', '--json']);
    expect(JSON.parse(mockConsoleLog.mock.calls.at(-1)![0] as string)).toEqual({
      ticketId: 'sup_7',
      status: 'open',
    });
  });
});

describe('support list', () => {
  it('unwraps {tickets} and renders a table', async () => {
    mockedApi.mockResolvedValue({
      tickets: [{ ticketId: 'sup_1', subject: 'a', status: 'open', lastActivityAt: '2026-08-05T00:00:00Z' }],
    });
    await run(['support', 'list']);
    expect(mockedApi).toHaveBeenCalledWith('/support/tickets');
    expect(logged()).toContain('sup_1');
  });

  it('empty list points at support new', async () => {
    mockedApi.mockResolvedValue({ tickets: [] });
    await run(['support', 'list']);
    expect(logged()).toContain('hookmyapp support new');
  });
});

describe('support show', () => {
  it('validates the ticket id locally — no HTTP on garbage', async () => {
    await expect(run(['support', 'show', 'ticket-9'])).rejects.toThrow(/Invalid ticket id/);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('rejects out-of-range --wait locally', async () => {
    await expect(run(['support', 'show', 'sup_1', '--wait', '30'])).rejects.toThrow(/--wait/);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('forwards wait + after as query params and renders roles + note', async () => {
    mockedApi.mockResolvedValue({
      ticketId: 'sup_1',
      subject: 's',
      status: 'open',
      messages: [
        { role: 'you', text: 'help', at: '2026-08-05T00:00:00Z' },
        { role: 'support', text: 'looking', at: '2026-08-05T00:01:00Z' },
      ],
      nextCursor: 'cur2',
      note: 'no reply yet — check again later',
    });
    await run(['support', 'show', 'sup_1', '--wait', '20', '--after', 'cur1']);
    expect(mockedApi).toHaveBeenCalledWith('/support/tickets/sup_1?wait=20&afterCursor=cur1');
    const out = logged();
    expect(out).toContain('[you]');
    expect(out).toContain('[support]');
    expect(out).toContain('no reply yet');
    expect(out).toContain('showing up to the 20 most recent messages');
  });
});

describe('support reply', () => {
  it('POSTs message + wait + cursor to /messages', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_1', subject: 's', status: 'open', messages: [], nextCursor: 'c' });
    await run(['support', 'reply', 'sup_1', '-m', 'more', '--wait', '10', '--after', 'cur1']);
    expect(mockedApi).toHaveBeenCalledWith('/support/tickets/sup_1/messages', {
      method: 'POST',
      body: JSON.stringify({ message: 'more', wait: 10, afterCursor: 'cur1' }),
    });
  });

  it('global --json flag also switches output to JSON', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_1', subject: 's', status: 'open', messages: [], nextCursor: 'c' });
    const program = makeProgram();
    await program.parseAsync(['node', 'hookmyapp', '--json', 'support', 'reply', 'sup_1', '-m', 'x']);
    expect(JSON.parse(mockConsoleLog.mock.calls.at(-1)![0] as string)).toMatchObject({ ticketId: 'sup_1' });
  });
});
