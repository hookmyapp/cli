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
  createAccessTokenForChannel,
  runAccessTokensCreate,
  runAccessTokensList,
  runAccessTokensRevoke,
} from '../access-tokens.js';

const channel = {
  id: 'ch_WAaaaaaa',
  type: 'whatsapp' as const,
  workspaceId: 'ws_TEST0001',
  credentialPublicId: 'cred_AAAA1111',
};

const jsonCmd = { optsWithGlobals: () => ({ json: true }) } as never;

beforeEach(() => {
  vi.mocked(apiClient).mockReset();
  vi.mocked(resolveChannel).mockReset();
  vi.mocked(getDefaultWorkspaceId).mockClear();
  vi.mocked(resolveChannel).mockResolvedValue(channel as never);
});

describe('createAccessTokenForChannel — side-effect-free helper', () => {
  it('POSTs /access-tokens/credentials/:credentialPublicId and returns the minted token without writing stdout', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({
      token: 'hmat_live_secret',
      publicId: 'tok_AAAA1111',
      tokenPrefix: 'hmat_live_AB',
      tokenSuffix: 'YZ',
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    const res = await createAccessTokenForChannel('@ordvir', 'prod');

    // Assert
    expect(vi.mocked(apiClient).mock.calls[0]).toEqual([
      '/access-tokens/credentials/cred_AAAA1111',
      { method: 'POST', workspaceId: 'ws_TEST0001', body: JSON.stringify({ label: 'prod' }) },
    ]);
    expect(res.token).toBe('hmat_live_secret');
    expect(outSpy).not.toHaveBeenCalled();
    outSpy.mockRestore();
  });
});

describe('runAccessTokensCreate — prints the plaintext token once', () => {
  it('When human mode, then prints the returned key exactly once', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({
      token: 'hmat_live_secret',
      publicId: 'tok_AAAA1111',
      tokenPrefix: 'hmat_live_AB',
      tokenSuffix: 'YZ',
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runAccessTokensCreate('@ordvir', {});

    // Assert
    expect(outSpy).toHaveBeenCalledOnce();
    expect(outSpy).toHaveBeenCalledWith('hmat_live_secret\n');
    outSpy.mockRestore();
  });

  it('When --json, then emits { publicId, tokenPrefix, tokenSuffix, key }', async () => {
    // Arrange
    const minted = { publicId: 'tok_AAAA1111', tokenPrefix: 'hmat_live_AB', tokenSuffix: 'YZ', token: 'hmat_live_secret' };
    vi.mocked(apiClient).mockResolvedValueOnce(minted);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runAccessTokensCreate('@ordvir', {}, jsonCmd);

    // Assert
    expect(JSON.parse((outSpy.mock.calls[0][0] as string).trim())).toMatchObject(minted);
    outSpy.mockRestore();
  });
});

describe('runAccessTokensList — GETs the credential path, never a full secret', () => {
  it('GETs /access-tokens/credentials/:credentialPublicId and prints prefix…suffix rows', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce({
      tokens: [{ publicId: 'tok_AAAA1111', tokenPrefix: 'hmat_live_AB', tokenSuffix: 'YZ', label: 'prod' }],
    });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runAccessTokensList('@ordvir');

    // Assert
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe('/access-tokens/credentials/cred_AAAA1111');
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('hmat_live_AB…YZ');
    outSpy.mockRestore();
  });
});

describe('runAccessTokensRevoke — DELETEs with a resolved workspaceId', () => {
  it('consults getDefaultWorkspaceId and DELETEs /access-tokens/:id with that workspaceId', async () => {
    // Arrange
    vi.mocked(apiClient).mockResolvedValueOnce(undefined);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Act
    await runAccessTokensRevoke('tok_AAAA1111');

    // Assert
    expect(getDefaultWorkspaceId).toHaveBeenCalledOnce();
    expect(vi.mocked(apiClient).mock.calls[0]).toEqual([
      '/access-tokens/tok_AAAA1111',
      { method: 'DELETE', workspaceId: 'ws_TEST0001' },
    ]);
    outSpy.mockRestore();
  });
});
