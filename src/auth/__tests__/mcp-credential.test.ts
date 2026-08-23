import { beforeEach, describe, expect, test, vi } from 'vitest';
import { apiClient } from '../../api/client.js';
import { readCredentials, saveCredentials } from '../store.js';
import { credentialName, getMcpAccessToken } from '../mcp-credential.js';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../store.js', () => ({ readCredentials: vi.fn(), saveCredentials: vi.fn() }));

const workosSession = {
  accessToken: 'eyJ.jwt.sig',
  refreshToken: 'refresh',
  expiresAt: 0,
};

const minted = { accessToken: 'hmok_new', publicId: 'ac_new' };

describe('the token handed to MCP clients', () => {
  beforeEach(() => vi.clearAllMocks());

  test('mints an org credential rather than handing over the session JWT', async () => {
    // The JWT has no `aud` claim, so /mcp rejects it — that was the bug.
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(minted);

    const token = await getMcpAccessToken();

    expect(token).toBe('hmok_new');
    expect(vi.mocked(apiClient).mock.calls.at(-1)?.[0]).toBe('/agent/credentials');
    expect(vi.mocked(apiClient).mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST' });
  });

  test('stores the minted key so the next MCP call does not mint again', async () => {
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(minted);

    await getMcpAccessToken();

    expect(saveCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAccessToken: 'hmok_new', mcpCredentialPublicId: 'ac_new' }),
    );
  });

  test('reuses a stored key and makes no network call', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ ...workosSession, mcpAccessToken: 'hmok_old' });

    expect(await getMcpAccessToken()).toBe('hmok_old');
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('uses an OTP session as-is — it already is an org credential', async () => {
    vi.mocked(readCredentials).mockResolvedValue({
      ...workosSession,
      accessToken: 'hmok_from_otp',
      kind: 'agent',
    });

    expect(await getMcpAccessToken()).toBe('hmok_from_otp');
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('revokes the previous key for this machine so re-logins do not stack them', async () => {
    const name = credentialName();
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient)
      .mockResolvedValueOnce([
        { publicId: 'ac_old', name },
        { publicId: 'ac_someone_else', name: 'other-laptop (HookMyApp CLI)' },
      ])
      .mockResolvedValueOnce(undefined) // delete
      .mockResolvedValueOnce(minted);

    await getMcpAccessToken();

    const deletes = vi.mocked(apiClient).mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe('/agent/credentials/ac_old');
  });

  test('still mints when the key list cannot be read', async () => {
    // An older backend, or an offline blip on the list call, must not stop the
    // user getting the credential they asked for.
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(minted);

    expect(await getMcpAccessToken()).toBe('hmok_new');
  });

  test('fails loudly when the mint returns nothing usable', async () => {
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce({});

    await expect(getMcpAccessToken()).rejects.toThrow(/did not return an org credential/);
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  test('keeps the credential name inside the 60-character server limit', () => {
    expect(credentialName('a'.repeat(80)).length).toBeLessThanOrEqual(60);
  });
});
