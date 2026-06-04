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
    credentialPublicId: 'cred_TEST0001',
    metaConnected: true,
    forwardingEnabled: true,
    webhookUrl: null,
    verifyToken: null,
  },
];

// Gateway model: the GET /env NEVER returns the real Meta token. `values`
// carries the gateway base URL + non-secret keys; the token key is injected
// on --write from the minted gateway key (createKeyForChannel).
const mockPayload = {
  channelType: 'whatsapp',
  values: {
    META_GRAPH_API_URL: 'https://gateway.hookmyapp.com/v22.0',
    WHATSAPP_PHONE_NUMBER_ID: '979105081963262',
    WHATSAPP_WABA_ID: '1248091060795230',
    HOOKMYAPP_CHANNEL_ID: 'ch_abc12345',
    VERIFY_TOKEN: 'verify_secret_xyz',
  },
  defaults: { PORT: '3000' },
  hasActiveKey: false,
};

const mintedKey = {
  key: 'hmp_live_MINTED',
  publicId: 'key_TEST0001',
  keyPrefix: 'hmp_live_MINT',
  keySuffix: 'NTED',
};

/**
 * Wire the apiClient mock so:
 *  - `/env` returns the gateway payload,
 *  - `/api-keys/credentials/...` POST (the --write mint) returns a minted key,
 *  - any other path (resolver `/meta/channels`) returns the fixture list.
 */
function mockApiClientForEnv(): void {
  mockedApiClient.mockImplementation(async (path: string) => {
    if (path.includes('/env')) return mockPayload;
    if (path.includes('/api-keys/credentials')) return mintedKey;
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
    expect(written).toContain('META_GRAPH_API_URL=https://gateway.hookmyapp.com/v22.0');
    // stdout (no --write): token field is a run-hint, never a real/minted token.
    expect(written).toContain('WHATSAPP_ACCESS_TOKEN=<run: hookmyapp keys create ch_abc12345>');
    expect(written).not.toContain('hmp_live_MINTED');
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

    // Assert — --write mints a gateway key and injects it under the token key.
    const result = readFileSync(envPath, 'utf8');
    expect(result).toContain('WHATSAPP_ACCESS_TOKEN=hmp_live_MINTED');
    expect(result).not.toContain('WHATSAPP_ACCESS_TOKEN=stale');
    expect(result).toContain('META_GRAPH_API_URL=https://gateway.hookmyapp.com/v22.0');
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
