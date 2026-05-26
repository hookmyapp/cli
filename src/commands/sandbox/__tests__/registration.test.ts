import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { ValidationError } from '../../../output/error.js';

vi.mock('../start.js', () => ({
  runSandboxStart: vi.fn(),
}));

import { runSandboxStart } from '../start.js';
import { registerSandboxCommand } from '../index.js';

describe('sandbox start positional [type]', () => {
  function parse(argv: string[]) {
    const program = new Command();
    program.option('--json', 'global');
    registerSandboxCommand(program);
    return program.parseAsync(argv, { from: 'user' });
  }

  it('positional "whatsapp" passes type=whatsapp to runSandboxStart', async () => {
    vi.mocked(runSandboxStart).mockReset();
    await parse(['sandbox', 'start', 'whatsapp']);
    expect(runSandboxStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'whatsapp' }),
    );
  });

  it('positional "instagram" with --listen', async () => {
    vi.mocked(runSandboxStart).mockReset();
    await parse(['sandbox', 'start', 'instagram', '--listen']);
    expect(runSandboxStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'instagram', listen: true }),
    );
  });

  it('positional and matching --type both → no conflict', async () => {
    vi.mocked(runSandboxStart).mockReset();
    await parse(['sandbox', 'start', 'whatsapp', '--type=whatsapp']);
    expect(runSandboxStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'whatsapp' }),
    );
  });

  it('positional and conflicting --type throws CONFLICTING_TYPE', async () => {
    vi.mocked(runSandboxStart).mockReset();
    await expect(
      parse(['sandbox', 'start', 'whatsapp', '--type=instagram']),
    ).rejects.toThrow(ValidationError);
  });

  it('--type flag form still works without positional', async () => {
    vi.mocked(runSandboxStart).mockReset();
    await parse(['sandbox', 'start', '--type=instagram']);
    expect(runSandboxStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'instagram' }),
    );
  });
});
