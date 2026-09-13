import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../../observability/telemetry.js', () => ({
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  maybePrintFirstRunDisclosure: vi.fn(),
}));

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient } from '../../api/client.js';
import { isTelemetryEnabled, maybePrintFirstRunDisclosure } from '../../observability/telemetry.js';
import { registerFeedbackCommand } from '../support.js';

const mockedApi = vi.mocked(apiClient);
const mockedTelemetry = vi.mocked(isTelemetryEnabled);

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  registerFeedbackCommand(program);
  return program;
}

beforeEach(() => {
  mockedApi.mockReset();
  mockedTelemetry.mockReturnValue(true);
  mockConsoleLog.mockClear();
});

/** AIT-458 — one-way friction report, gated by the telemetry switch. */
describe('hookmyapp feedback', () => {
  it('posts the message plus surface and echoes the no-reply note', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_7', note: 'no reply is coming' });
    await makeProgram().parseAsync(['feedback', 'gave up on the connect flow', '--surface', 'docs'], { from: 'user' });

    expect(mockedApi).toHaveBeenCalledWith('/support/feedback', {
      method: 'POST',
      body: JSON.stringify({ message: 'gave up on the connect flow', surface: 'docs' }),
    });
    expect(mockConsoleLog.mock.calls[0][0]).toContain('sup_7');
    expect(mockConsoleLog.mock.calls[0][0]).toContain('no reply is coming');
  });

  it('omits the surface when not given — the calling CLI is not where the friction happened', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_8', note: 'n' });
    await makeProgram().parseAsync(['feedback', 'confusing error'], { from: 'user' });
    expect(JSON.parse((mockedApi.mock.calls[0][1] as { body: string }).body)).toEqual({
      message: 'confusing error',
    });
  });

  it('still sends when the disclosure cannot persist its flag', async () => {
    vi.mocked(maybePrintFirstRunDisclosure).mockImplementationOnce(() => {
      throw new Error('EROFS: read-only file system');
    });
    mockedApi.mockResolvedValue({ ticketId: 'sup_11', note: 'n' });
    await makeProgram().parseAsync(['feedback', 'confusing'], { from: 'user' });
    expect(mockedApi).toHaveBeenCalled();
  });

  it('sends nothing when telemetry is off', async () => {
    mockedTelemetry.mockReturnValue(false);
    await makeProgram().parseAsync(['feedback', 'confusing error'], { from: 'user' });
    expect(mockedApi).not.toHaveBeenCalled();
    expect(mockConsoleLog.mock.calls[0][0]).toContain('config set telemetry on');
  });

  it('shows the telemetry disclosure before the message leaves the machine', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_9', note: 'n' });
    await makeProgram().parseAsync(['feedback', 'confusing'], { from: 'user' });
    // Must not depend on Sentry having initialized — a CLI built without a DSN
    // would otherwise upload the message with no disclosure ever shown.
    expect(maybePrintFirstRunDisclosure).toHaveBeenCalled();
  });

  it('errors instead of blocking on stdin when run bare in a terminal', async () => {
    const wasTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(makeProgram().parseAsync(['feedback'], { from: 'user' })).rejects.toThrow(/argument or pipe/);
      expect(mockedApi).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: wasTty, configurable: true });
    }
  });

  it('prints cleanly when the backend omits the note', async () => {
    mockedApi.mockResolvedValue({ ticketId: 'sup_10' });
    await makeProgram().parseAsync(['feedback', 'confusing'], { from: 'user' });
    expect(mockConsoleLog.mock.calls[0][0]).toBe('Thanks — recorded as sup_10.');
  });

  it('rejects an unknown surface before calling the API', async () => {
    await expect(
      makeProgram().parseAsync(['feedback', 'x', '--surface', 'carrier-pigeon'], { from: 'user' }),
    ).rejects.toThrow(/--surface must be one of/);
    expect(mockedApi).not.toHaveBeenCalled();
  });
});
