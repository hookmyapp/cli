import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: 'ws_TEST0010' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';

const mockedApiClient = vi.mocked(apiClient);

const fakeChannels = [
  {
    id: 'ch_abc12345',
    type: 'whatsapp',
    workspaceId: 'ws_TEST0010',
    metaWabaId: '1248091060795230',
    metaResourceId: '979105081963262',
    phoneNumberId: '979105081963262',
    displayPhoneNumber: '+972 55-727-7945',
    wabaName: 'tomer office',
    phoneVerifiedName: null,
    qualityRating: null,
    qualityRatingCheckedAt: null,
    connectionType: 'cloud_api',
    metaConnected: true,
    forwardingEnabled: true,
    webhookUrl: null,
    verifyToken: null,
  },
];

const mockPayload = {
  channelType: 'whatsapp',
  values: {
    WHATSAPP_API_URL: 'https://graph.facebook.com/v24.0',
    WHATSAPP_ACCESS_TOKEN: 'EAA_test_token',
    WHATSAPP_PHONE_NUMBER_ID: '979105081963262',
    WHATSAPP_WABA_ID: '1248091060795230',
    HOOKMYAPP_CHANNEL_ID: 'ch_abc12345',
    VERIFY_TOKEN: 'verify_secret_xyz',
  },
  defaults: { PORT: '3000' },
};

/**
 * Wire the apiClient mock so any path containing `/env` returns the new
 * payload and the channel-list discovery call returns the fixture above.
 * Resolver-side calls (`/meta/channels`) hit the list branch; the env
 * command hits the `/env` branch.
 */
function mockApiClientForEnv(): void {
  mockedApiClient.mockImplementation(async (path: string) => {
    if (path.includes('/env')) return mockPayload;
    return fakeChannels;
  });
}

describe('env command', () => {
  let runChannelEnv: typeof import('../commands/env.js').runChannelEnv;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockConsoleError.mockClear();

    const mod = await import('../commands/env.js');
    runChannelEnv = mod.runChannelEnv;
  });

  async function runEnvCommand(args: string[]): Promise<void> {
    const channelRef = args[0];
    const writeIndex = args.indexOf('--write');
    const write =
      writeIndex === -1 ? undefined : (args[writeIndex + 1] ?? true);
    await runChannelEnv(channelRef, { write });
  }

  it('fetches /meta/channels then /meta/channels/:id/env, emits values+defaults as dotenv lines', async () => {
    // Arrange
    mockApiClientForEnv();
    const mockWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runEnvCommand(['ch_abc12345']);

    // Assert
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_abc12345/env', {
      workspaceId: 'ws_TEST0010',
    });
    const written = mockWrite.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('WHATSAPP_ACCESS_TOKEN=EAA_test_token');
    expect(written).toContain('HOOKMYAPP_CHANNEL_ID=ch_abc12345');
    expect(written).toContain('PORT=3000');
    mockWrite.mockRestore();
  });

  it('throws CliError when channel not found', async () => {
    // Arrange
    mockedApiClient.mockResolvedValueOnce(fakeChannels);

    // Act + Assert
    await expect(
      runEnvCommand(['ch_zzzzzzzz']),
    ).rejects.toThrow(/No channel matches ch_zzzzzzzz/);
  });

  it('writes all `values` keys overwriting existing entries', async () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'WHATSAPP_ACCESS_TOKEN=stale\nUSER_CUSTOM=keep\n');
    mockApiClientForEnv();

    // Act
    await runEnvCommand(['ch_abc12345', '--write', envPath]);

    // Assert
    const result = readFileSync(envPath, 'utf8');
    expect(result).toContain('WHATSAPP_ACCESS_TOKEN=EAA_test_token');
    expect(result).toContain('WHATSAPP_API_URL=https://graph.facebook.com/v24.0');
    expect(result).toContain('HOOKMYAPP_CHANNEL_ID=ch_abc12345');
    expect(result).toContain('USER_CUSTOM=keep');
  });

  it('preserves existing PORT when present (defaults are preserve-if-exists)', async () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'PORT=4000\n');
    mockApiClientForEnv();

    // Act
    await runEnvCommand(['ch_abc12345', '--write', envPath]);

    // Assert
    const result = readFileSync(envPath, 'utf8');
    expect(result).toContain('PORT=4000');
    expect(result).not.toContain('PORT=3000');
  });

  it('writes PORT=3000 when absent (defaults are preserve-if-exists)', async () => {
    // Arrange
    const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, '');
    mockApiClientForEnv();

    // Act
    await runEnvCommand(['ch_abc12345', '--write', envPath]);

    // Assert
    const result = readFileSync(envPath, 'utf8');
    expect(result).toContain('PORT=3000');
  });
});
