import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { ValidationError } from '../../../output/error.js';

vi.mock('../logs.js', () => ({
  runSandboxLogs: vi.fn(),
}));

import { runSandboxLogs } from '../logs.js';
import { registerSandboxCommand } from '../index.js';

// Regression for Sentry HOOKMYAPP-CLI-J: `sandbox logs --limit abc` parsed to
// NaN and sent `limit=NaN` to the API (400), which then crashed the error
// renderer. A bad --limit must be rejected locally (ValidationError → exit 2)
// and never reach runSandboxLogs.
describe('sandbox logs --limit validation', () => {
  function parse(argv: string[]) {
    const program = new Command();
    program.option('--json', 'global');
    registerSandboxCommand(program);
    return program.parseAsync(argv, { from: 'user' });
  }

  beforeEach(() => {
    vi.mocked(runSandboxLogs).mockReset();
  });

  it('rejects a non-numeric --limit locally with ValidationError (exit 2) and never calls runSandboxLogs', async () => {
    await expect(
      parse(['sandbox', 'logs', '--session', 'ssn_tJCqHWBy', '--limit', 'abc']),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(runSandboxLogs).not.toHaveBeenCalled();
  });

  it('rejects an out-of-range --limit (0, 101, fractional) before any API call', async () => {
    for (const bad of ['0', '101', '1.5']) {
      vi.mocked(runSandboxLogs).mockReset();
      await expect(
        parse(['sandbox', 'logs', '--session', 'ssn_a', '--limit', bad]),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(runSandboxLogs).not.toHaveBeenCalled();
    }
  });

  it('passes a valid --limit through as a number', async () => {
    await parse(['sandbox', 'logs', '--session', 'ssn_a', '--limit', '10']);
    expect(runSandboxLogs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('omitting --limit passes limit=undefined (runSandboxLogs applies its default)', async () => {
    await parse(['sandbox', 'logs', '--session', 'ssn_a']);
    expect(runSandboxLogs).toHaveBeenCalledWith(
      expect.objectContaining({ limit: undefined }),
    );
  });
});
