import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: '10101010-1010-1010-1010-101010101010' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';

const mockedApiClient = vi.mocked(apiClient);

const fakeAccounts = [
  { id: '11111111-1111-1111-1111-111111111111', metaWabaId: 'waba-111', phoneNumberId: 'phone-222', workspaceId: '10101010-1010-1010-1010-101010101010' },
];

describe('env command', () => {
  let registerEnvCommand: typeof import('../commands/env.js').registerEnvCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockConsoleError.mockClear();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/env.js');
    registerEnvCommand = mod.registerEnvCommand;
  });

  it('envCommand fetches account list + token, outputs dotenv format lines', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts) // accounts list
      .mockResolvedValueOnce({ accessToken: 'EAABtoken123' }); // token

    const mockWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const program = new Command();
    registerEnvCommand(program);
    await program.parseAsync(['env', 'waba-111'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/11111111-1111-1111-1111-111111111111/token');

    const written = mockWrite.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('WABA_ID=waba-111');
    expect(written).toContain('ACCESS_TOKEN=EAABtoken123');
    expect(written).toContain('PHONE_NUMBER_ID=phone-222');
    mockWrite.mockRestore();
  });

  it('throws CliError when account not found', async () => {
    mockedApiClient.mockResolvedValueOnce(fakeAccounts);

    const program = new Command();
    registerEnvCommand(program);

    await expect(
      program.parseAsync(['env', '999'], { from: 'user' }),
    ).rejects.toThrow('account not found');
  });
});
