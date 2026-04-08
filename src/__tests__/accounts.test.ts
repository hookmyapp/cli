import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn(),
}));

// Mock output
vi.mock('../output/format.js', () => ({
  output: vi.fn(),
}));

// Mock open
vi.mock('open', () => ({
  default: vi.fn(),
}));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: '10101010-1010-1010-1010-101010101010' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// Mock store
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({ accessToken: 'test-token', refreshToken: 'test-refresh' }),
  saveCredentials: vi.fn(),
}));

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import open from 'open';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);
const mockedOpen = vi.mocked(open);

const fakeAccounts = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    workspaceId: '10101010-1010-1010-1010-101010101010',
    metaWabaId: 'waba-1',
    wabaName: 'Test WABA',
    displayPhoneNumber: '+1 234 567 890',
    phoneVerifiedName: 'Test Verified',
    connectionType: 'cloud_api',
    metaConnected: true,
    forwardingEnabled: true,
    qualityRating: 'GREEN',
    webhookUrl: 'https://example.com/webhook',
    verifyToken: 'tok-123',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    workspaceId: '20202020-2020-2020-2020-202020202020',
    metaWabaId: 'waba-2',
    wabaName: 'Another WABA',
    displayPhoneNumber: '+1 987 654 321',
    phoneVerifiedName: null,
    connectionType: 'coexistence',
    metaConnected: true,
    forwardingEnabled: true,
    qualityRating: null,
    webhookUrl: null,
    verifyToken: null,
  },
];

const fakeDetailResponse = {
  id: '22222222-2222-2222-2222-222222222222',
  workspaceId: '20202020-2020-2020-2020-202020202020',
  metaWabaId: 'waba-2',
  wabaName: 'Another WABA',
  displayPhoneNumber: '+1 987 654 321',
  phoneVerifiedName: null,
  connectionType: 'coexistence',
  metaConnected: true,
  forwardingEnabled: true,
  qualityRating: null,
  accessToken: 'real-token-value',
  businessName: 'Acme Corp',
  metaBusinessId: 'biz-123',
  phoneNumberId: 'phone-2',
  webhookUrl: null,
  verifyToken: null,
};

describe('accounts commands', () => {
  let registerAccountsCommand: typeof import('../commands/accounts.js').registerAccountsCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockedOpen.mockReset();
    mockConsoleError.mockClear();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/accounts.js');
    registerAccountsCommand = mod.registerAccountsCommand;
  });

  it('listAccounts calls apiClient /meta/accounts with workspaceId and passes display fields to output', async () => {
    mockedApiClient.mockResolvedValue(fakeAccounts);

    const program = new Command();
    registerAccountsCommand(program);
    await program.parseAsync(['accounts', 'list'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    // Verify output was called with filtered + display-picked accounts
    expect(mockedOutput).toHaveBeenCalledTimes(1);
    const outputArgs = mockedOutput.mock.calls[0][0];
    // Both accounts are metaConnected=true, so both should be in output
    expect(outputArgs).toHaveLength(2);
    // pickDisplayFields removes id, workspaceId, and qualityRating (re-adds only for non-coexistence with value)
    expect(outputArgs[0]).not.toHaveProperty('id');
    expect(outputArgs[0]).not.toHaveProperty('workspaceId');
    expect(outputArgs[0]).toHaveProperty('metaWabaId', 'waba-1');
    expect(outputArgs[0]).toHaveProperty('qualityRating', 'GREEN'); // cloud_api with value
    expect(outputArgs[1]).not.toHaveProperty('qualityRating'); // coexistence, null quality
  });

  it('showAccount calls list to resolve, then calls detail endpoint, outputs without routing keys', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts) // list call for resolveAccount (with workspaceId)
      .mockResolvedValueOnce(fakeDetailResponse); // detail endpoint call

    const program = new Command();
    registerAccountsCommand(program);
    await program.parseAsync(['accounts', 'show', 'waba-2'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/22222222-2222-2222-2222-222222222222');
    // pickDisplayFields removes id, workspaceId, and qualityRating (coexistence + null = not re-added)
    expect(mockedOutput).toHaveBeenCalledTimes(1);
    const outputArgs = mockedOutput.mock.calls[0][0];
    expect(outputArgs).not.toHaveProperty('id');
    expect(outputArgs).not.toHaveProperty('workspaceId');
    expect(outputArgs).not.toHaveProperty('qualityRating');
    expect(outputArgs).toHaveProperty('metaWabaId', 'waba-2');
    expect(outputArgs).toHaveProperty('accessToken', 'real-token-value');
  });

  it('throws CliError when account not found', async () => {
    mockedApiClient.mockResolvedValue(fakeAccounts);

    const program = new Command();
    registerAccountsCommand(program);

    await expect(
      program.parseAsync(['accounts', 'show', '999'], { from: 'user' }),
    ).rejects.toThrow('account not found');
  });

  it('disconnectAccount calls apiClient with POST and workspaceId from account lookup', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts) // account lookup (with workspaceId)
      .mockResolvedValueOnce({ success: true }); // disconnect call

    const program = new Command();
    registerAccountsCommand(program);
    await program.parseAsync(['accounts', 'disconnect', 'waba-1'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/11111111-1111-1111-1111-111111111111/disconnect', {
      method: 'POST',
      workspaceId: '10101010-1010-1010-1010-101010101010',
    });
  });

  it('connectAccount calls forceTokenRefresh and opens Embedded Signup URL', async () => {
    // First call: fetchAppConfig -> /config
    // Second call: snapshot accounts -> /meta/accounts (the poll will timeout, but we test the initial flow)
    mockedApiClient
      .mockResolvedValueOnce({ metaAppId: '123456', metaConfigId: 'config-1' }) // /config
      .mockResolvedValueOnce([]); // initial snapshot /meta/accounts
    // Suppress console.log
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerAccountsCommand(program);
    // Don't await -- it will poll for 15 min. Just verify the initial flow.
    const p = program.parseAsync(['accounts', 'connect'], { from: 'user' });

    // Wait a tick for the async calls to resolve
    await new Promise((r) => setTimeout(r, 50));

    const { forceTokenRefresh } = await import('../api/client.js');
    expect(forceTokenRefresh).toHaveBeenCalled();
    expect(mockedOpen).toHaveBeenCalledWith(expect.stringContaining('facebook.com'));

    // Clean up: restore console.log to stop polling side effects
    vi.mocked(console.log).mockRestore();
  });

  it('enableAccount calls apiClient with POST and workspaceId', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts)
      .mockResolvedValueOnce({ enabled: true });

    const program = new Command();
    registerAccountsCommand(program);
    await program.parseAsync(['accounts', 'enable', 'waba-2'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/22222222-2222-2222-2222-222222222222/enable', {
      method: 'POST',
      workspaceId: '20202020-2020-2020-2020-202020202020',
    });
  });

  it('disableAccount calls apiClient with POST and workspaceId', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts)
      .mockResolvedValueOnce({ disabled: true });

    const program = new Command();
    registerAccountsCommand(program);
    await program.parseAsync(['accounts', 'disable', 'waba-2'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/22222222-2222-2222-2222-222222222222/disable', {
      method: 'POST',
      workspaceId: '20202020-2020-2020-2020-202020202020',
    });
  });
});

describe('health command', () => {
  let registerHealthCommand: typeof import('../commands/health.js').registerHealthCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockConsoleError.mockClear();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/health.js');
    registerHealthCommand = mod.registerHealthCommand;
  });

  it('health command calls refresh with POST and workspaceId', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeAccounts) // account lookup
      .mockResolvedValueOnce({ metaConnected: true, forwardingEnabled: true, wabaName: 'Test' }); // health result

    const program = new Command();
    registerHealthCommand(program);
    await program.parseAsync(['health', 'waba-1'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts', { workspaceId: '10101010-1010-1010-1010-101010101010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/accounts/11111111-1111-1111-1111-111111111111/refresh', {
      method: 'POST',
      workspaceId: '10101010-1010-1010-1010-101010101010',
    });
    expect(mockedOutput).toHaveBeenCalledWith(
      { metaConnected: true, forwardingEnabled: true, wabaName: 'Test' },
      expect.objectContaining({}),
    );
  });
});
