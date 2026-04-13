import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

// Mock output
vi.mock('../output/format.js', () => ({
  output: vi.fn(),
}));

// Mock workspace helpers
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws-123'),
}));

// Mock workspace config (required by _helpers transitive)
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: 'ws-123' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// Mock store
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({ accessToken: 'test-token', refreshToken: 'test-refresh' }),
  saveCredentials: vi.fn(),
}));

// Mock @inquirer/prompts
vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { input, confirm, select } from '@inquirer/prompts';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);
const mockedInput = vi.mocked(input);
const mockedConfirm = vi.mocked(confirm);
const mockedSelect = vi.mocked(select);

const fakeSession = {
  id: 'sess-1',
  workspaceId: 'ws-123',
  phone: '+1234567890',
  activationCode: 'SANDBOX-ABC123',
  status: 'pending_activation' as const,
  webhookUrl: null,
  ngrokDomainId: null,
  ngrokDomain: null,
  ngrokCredentialId: null,
  ngrokAuthToken: null,
  hmacSecret: 'hmac-secret',
  activatedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const fakeActiveSession = {
  ...fakeSession,
  status: 'active' as const,
  ngrokDomain: 'my-tunnel.ngrok.dev',
  ngrokAuthToken: 'ngrok-token-123',
  webhookUrl: 'https://my-tunnel.ngrok.dev/webhook',
  activatedAt: '2026-01-01T00:01:00Z',
};

describe('sandbox commands', () => {
  let registerSandboxCommand: typeof import('../commands/sandbox.js').registerSandboxCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockedInput.mockReset();
    mockedConfirm.mockReset();
    mockedSelect.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/sandbox.js');
    registerSandboxCommand = mod.registerSandboxCommand;
  });

  it('sandbox start with --phone creates session', async () => {
    mockedApiClient.mockResolvedValueOnce(fakeSession);

    const program = new Command();
    registerSandboxCommand(program);
    await program.parseAsync(['sandbox', 'start', '--phone', '+1234567890'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/sandbox/sessions', {
      method: 'POST',
      body: JSON.stringify({ phone: '+1234567890' }),
      workspaceId: 'ws-123',
    });
    expect(mockedOutput).toHaveBeenCalledWith(fakeSession, { human: false });
  });

  it('sandbox start without --phone prompts interactively', async () => {
    mockedInput.mockResolvedValueOnce('+9876543210');
    mockedApiClient.mockResolvedValueOnce(fakeSession);

    const program = new Command();
    registerSandboxCommand(program);
    await program.parseAsync(['sandbox', 'start'], { from: 'user' });

    expect(mockedInput).toHaveBeenCalledWith({
      message: 'Phone number for WhatsApp activation (e.g. +1234567890):',
    });
    expect(mockedApiClient).toHaveBeenCalledWith('/sandbox/sessions', {
      method: 'POST',
      body: JSON.stringify({ phone: '+9876543210' }),
      workspaceId: 'ws-123',
    });
  });

  it('sandbox status lists sessions', async () => {
    mockedApiClient.mockResolvedValueOnce([fakeSession, fakeActiveSession]);

    const program = new Command();
    registerSandboxCommand(program);
    await program.parseAsync(['sandbox', 'status'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/sandbox/sessions', { workspaceId: 'ws-123' });
    expect(mockedOutput).toHaveBeenCalledWith([fakeSession, fakeActiveSession], { human: false });
  });

  it('sandbox stop with single session deletes it', async () => {
    mockedApiClient.mockResolvedValueOnce([fakeSession]); // list
    mockedConfirm.mockResolvedValueOnce(true);
    mockedApiClient.mockResolvedValueOnce(undefined); // delete

    const program = new Command();
    registerSandboxCommand(program);
    await program.parseAsync(['sandbox', 'stop'], { from: 'user' });

    expect(mockedConfirm).toHaveBeenCalled();
    expect(mockedApiClient).toHaveBeenCalledWith('/sandbox/sessions/sess-1', {
      method: 'DELETE',
      workspaceId: 'ws-123',
    });
  });

  it('sandbox stop with multiple sessions prompts selection', async () => {
    const session2 = { ...fakeActiveSession, id: 'sess-2', phone: '+1111111111' };
    mockedApiClient.mockResolvedValueOnce([fakeSession, session2]); // list
    mockedSelect.mockResolvedValueOnce('sess-2');
    mockedConfirm.mockResolvedValueOnce(true);
    mockedApiClient.mockResolvedValueOnce(undefined); // delete

    const program = new Command();
    registerSandboxCommand(program);
    await program.parseAsync(['sandbox', 'stop'], { from: 'user' });

    expect(mockedSelect).toHaveBeenCalled();
    expect(mockedConfirm).toHaveBeenCalled();
    expect(mockedApiClient).toHaveBeenCalledWith('/sandbox/sessions/sess-2', {
      method: 'DELETE',
      workspaceId: 'ws-123',
    });
  });

  it('sandbox stop with no sessions throws error', async () => {
    mockedApiClient.mockResolvedValueOnce([]); // empty list

    const program = new Command();
    program.exitOverride();
    registerSandboxCommand(program);

    await expect(
      program.parseAsync(['sandbox', 'stop'], { from: 'user' }),
    ).rejects.toThrow('No sandbox sessions found');
  });
});
