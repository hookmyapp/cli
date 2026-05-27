import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerConfigCommand } from '../config.js';

describe('config show --json (D7)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  test('When --json, then output is collapsed to {env, telemetry}', async () => {
    const program = new Command();
    program.option('--json');
    registerConfigCommand(program);
    await program.parseAsync(['node', 'hookmyapp', 'config', 'show', '--json']);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(Object.keys(parsed).sort()).toEqual(['env', 'telemetry']);
    expect(typeof parsed.env).toBe('string');
    expect(typeof parsed.telemetry).toBe('string');
    expect(['on', 'off']).toContain(parsed.telemetry);
  });
});
