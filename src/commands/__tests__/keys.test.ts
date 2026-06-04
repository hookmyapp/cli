import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../channels.js', () => ({ resolveChannel: vi.fn() }));
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../api/client.js';
import { resolveChannel } from '../channels.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import {
  createKeyForChannel,
  runKeysCreate,
  runKeysList,
  runKeysRevoke,
} from '../keys.js';

const channel = {
  id: 'ch_WAaaaaaa',
  type: 'whatsapp' as const,
  workspaceId: 'ws_TEST0001',
  connectionId: 'conn_AAAA1111',
};

const jsonCmd = { optsWithGlobals: () => ({ json: true }) } as never;

beforeEach(() => {
  vi.mocked(apiClient).mockReset();
  vi.mocked(resolveChannel).mockReset();
  vi.mocked(getDefaultWorkspaceId).mockClear();
  vi.mocked(resolveChannel).mockResolvedValue(channel as never);
});

describe('createKeyForChannel — side-effect-free helper', () => {
  it('POSTs /api-keys/connections/:connId and returns the minted key without writing stdout', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({
      key: 'hmp_live_secret',
      publicId: 'key_AAAA1111',
      keyPrefix: 'hmp_live_AB',
      keySuffix: 'YZ',
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    const res = await createKeyForChannel('@ordvir', 'prod');

    // Assert
    expect(vi.mocked(apiClient).mock.calls[0]).toEqual([
      '/api-keys/connections/conn_AAAA1111',
      { method: 'POST', workspaceId: 'ws_TEST0001', body: JSON.stringify({ label: 'prod' }) },
    ]);
    expect(res.key).toBe('hmp_live_secret');
    expect(outSpy).not.toHaveBeenCalled();
    outSpy.mockRestore();
  });
});

describe('runKeysCreate — prints the plaintext key once', () => {
  it('When human mode, then prints the returned key exactly once', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({
      key: 'hmp_live_secret',
      publicId: 'key_AAAA1111',
      keyPrefix: 'hmp_live_AB',
      keySuffix: 'YZ',
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runKeysCreate('@ordvir', {});

    // Assert
    expect(outSpy).toHaveBeenCalledOnce();
    expect(outSpy).toHaveBeenCalledWith('hmp_live_secret\n');
    outSpy.mockRestore();
  });

  it('When --json, then emits { publicId, keyPrefix, keySuffix, key }', async () => {
    // Arrange
    const minted = { publicId: 'key_AAAA1111', keyPrefix: 'hmp_live_AB', keySuffix: 'YZ', key: 'hmp_live_secret' };
    vi.mocked(apiClient).mockResolvedValueOnce(minted);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runKeysCreate('@ordvir', {}, jsonCmd);

    // Assert
    expect(JSON.parse((outSpy.mock.calls[0][0] as string).trim())).toMatchObject(minted);
    outSpy.mockRestore();
  });
});

describe('runKeysList — GETs the connection path, never a full key', () => {
  it('GETs /api-keys/connections/:connId and prints prefix…suffix rows', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({
      keys: [{ publicId: 'key_AAAA1111', keyPrefix: 'hmp_live_AB', keySuffix: 'YZ', label: 'prod' }],
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runKeysList('@ordvir');

    // Assert
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe('/api-keys/connections/conn_AAAA1111');
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('hmp_live_AB…YZ');
    outSpy.mockRestore();
  });
});

describe('runKeysRevoke — DELETEs with a resolved workspaceId', () => {
  it('consults getDefaultWorkspaceId and DELETEs /api-keys/:id with that workspaceId', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce(undefined);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runKeysRevoke('key_AAAA1111');

    // Assert
    expect(getDefaultWorkspaceId).toHaveBeenCalledOnce();
    expect(vi.mocked(apiClient).mock.calls[0]).toEqual([
      '/api-keys/key_AAAA1111',
      { method: 'DELETE', workspaceId: 'ws_TEST0001' },
    ]);
    outSpy.mockRestore();
  });
});
