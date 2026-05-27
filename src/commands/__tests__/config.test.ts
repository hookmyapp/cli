import { describe, test, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerConfigCommand } from '../config.js';
import { getPersistedEnv } from '../../config/env-profiles.js';
import { getPersistedTelemetry } from '../../observability/telemetry.js';

vi.mock('../../config/env-profiles.js', async (orig) => {
  const actual = await orig<typeof import('../../config/env-profiles.js')>();
  return {
    ...actual,
    getPersistedEnv: vi.fn(() => undefined),
    setPersistedEnv: vi.fn(),
    unsetPersistedEnv: vi.fn(),
  };
});

vi.mock('../../observability/telemetry.js', async (orig) => {
  const actual = await orig<typeof import('../../observability/telemetry.js')>();
  return {
    ...actual,
    getPersistedTelemetry: vi.fn(() => null),
    setPersistedTelemetry: vi.fn(),
    unsetPersistedTelemetry: vi.fn(),
    isTelemetryEnabled: vi.fn(() => true),
  };
});

describe('config show --json (D7)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(getPersistedEnv).mockReturnValue(undefined);
    vi.mocked(getPersistedTelemetry).mockReturnValue(null);
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

describe('config get --json (D7)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(getPersistedEnv).mockReturnValue(undefined);
    vi.mocked(getPersistedTelemetry).mockReturnValue(null);
  });

  test('When config get env --json with no persisted override, then value is omitted', async () => {
    vi.mocked(getPersistedEnv).mockReturnValue(undefined);

    const program = new Command();
    program.option('--json');
    registerConfigCommand(program);
    await program.parseAsync(['node', 'hookmyapp', 'config', 'get', 'env', '--json']);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).not.toHaveProperty('key');
    expect(parsed).not.toHaveProperty('value');
    expect(parsed).toHaveProperty('active');
    expect(parsed).toHaveProperty('default');
  });

  test('When config get env --json with persisted override, then value is present', async () => {
    vi.mocked(getPersistedEnv).mockReturnValue('staging');

    const program = new Command();
    program.option('--json');
    registerConfigCommand(program);
    await program.parseAsync(['node', 'hookmyapp', 'config', 'get', 'env', '--json']);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('value', 'staging');
    expect(parsed).not.toHaveProperty('key');
    expect(parsed).toHaveProperty('active');
    expect(parsed).toHaveProperty('default');
  });

  test('When config get telemetry --json with no persisted override, then value is omitted', async () => {
    vi.mocked(getPersistedTelemetry).mockReturnValue(null);

    const program = new Command();
    program.option('--json');
    registerConfigCommand(program);
    await program.parseAsync(['node', 'hookmyapp', 'config', 'get', 'telemetry', '--json']);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).not.toHaveProperty('key');
    expect(parsed).not.toHaveProperty('value');
    expect(parsed).toHaveProperty('active');
    expect(parsed).toHaveProperty('default');
  });

  test('When config get telemetry --json with persisted override, then value is present', async () => {
    vi.mocked(getPersistedTelemetry).mockReturnValue('off');

    const program = new Command();
    program.option('--json');
    registerConfigCommand(program);
    await program.parseAsync(['node', 'hookmyapp', 'config', 'get', 'telemetry', '--json']);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('value', 'off');
    expect(parsed).not.toHaveProperty('key');
  });
});
