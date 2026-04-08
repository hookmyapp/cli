import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));

// Mock output
vi.mock('../output/format.js', () => ({
  output: vi.fn(),
}));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: '10101010-1010-1010-1010-101010101010' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// Mock store (needed by webhook set command)
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({ accessToken: 'test-token', refreshToken: 'test-refresh' }),
  saveCredentials: vi.fn(),
}));

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);

const fakeAccounts = [
  { id: '11111111-1111-1111-1111-111111111111', metaWabaId: 'waba-1', wabaName: 'Test WABA', phoneNumberId: 'phone-1', workspaceId: '10101010-1010-1010-1010-101010101010' },
];

// Mock global fetch for webhook set command's direct fetch call
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('webhook commands', () => {
  let registerWebhookCommand: typeof import('../commands/webhook.js').registerWebhookCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockConsoleError.mockClear();
    mockFetch.mockReset();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/webhook.js');
    registerWebhookCommand = mod.registerWebhookCommand;
  });

  it('showWebhook calls apiClient /webhook-config/:accountId', async () => {
    const config = { webhookUrl: 'https://example.com/hook', verifyToken: 'abc123' };
    // First call: resolveAccount -> /meta/accounts
    // Second call: /webhook-config/:id
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts)
      .mockResolvedValueOnce(config);

    const program = new Command();
    registerWebhookCommand(program);
    await program.parseAsync(['webhook', 'show', 'waba-1'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/webhook-config/11111111-1111-1111-1111-111111111111');
    expect(mockedOutput).toHaveBeenCalledWith(config, expect.objectContaining({}));
  });

  it('setWebhook calls apiClient to configure webhook for account', async () => {
    // resolveAccount -> /meta/accounts
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts)
      .mockResolvedValueOnce({ updated: true }); // PUT webhook-config

    // Mock fetch for the direct check call (returns 200 = existing config)
    mockFetch.mockResolvedValueOnce({ ok: true });

    // Suppress console.log
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerWebhookCommand(program);
    await program.parseAsync(['webhook', 'set', 'waba-1', '--url', 'https://example.com/hook', '--verify-token', 'secret'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/webhook-config/11111111-1111-1111-1111-111111111111', {
      method: 'PUT',
      body: JSON.stringify({ webhookUrl: 'https://example.com/hook', verifyToken: 'secret' }),
    });
  });

  it('setWebhook throws CliError when --url flag is missing', async () => {
    const program = new Command();
    registerWebhookCommand(program);

    await expect(
      program.parseAsync(['webhook', 'set', 'waba-1'], { from: 'user' }),
    ).rejects.toThrow('--url flag is required');
  });
});

describe('token command', () => {
  let registerTokenCommand: typeof import('../commands/token.js').registerTokenCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/token.js');
    registerTokenCommand = mod.registerTokenCommand;
  });

  it('token command calls apiClient /meta/accounts/:id/token and writes raw token to stdout', async () => {
    // resolveAccount -> /meta/accounts, then /meta/accounts/:id/token
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts)
      .mockResolvedValueOnce({ accessToken: 'EAABxyz123' });
    const mockWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const program = new Command();
    registerTokenCommand(program);
    await program.parseAsync(['token', 'waba-1'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/11111111-1111-1111-1111-111111111111/token');
    expect(mockWrite).toHaveBeenCalledWith('EAABxyz123\n');
    mockWrite.mockRestore();
  });
});
