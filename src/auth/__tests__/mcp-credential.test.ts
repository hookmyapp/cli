import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiClient } from '../../api/client.js';
import { readCredentials } from '../store.js';
import {
  credentialName,
  revokePreviousMcpCredential,
  deleteMcpCredential,
  getMcpAccessToken,
  readMcpCredential,
  revokeKeysForThisMachine,
} from '../mcp-credential.js';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../store.js', () => ({ readCredentials: vi.fn(), saveCredentials: vi.fn() }));

const workosSession = {
  accessToken: 'eyJ.jwt.sig',
  refreshToken: 'refresh',
  expiresAt: 0,
};

/** EXACTLY what POST /agent/credentials returns. It answers `token`; the OTP
 *  endpoint answers `accessToken`, and mocking that shape here hid a bug that
 *  made the whole feature fail closed until it was caught against staging. */
const mintResponse = { token: 'hmok_new', publicId: 'ac_new', scopes: [], name: 'laptop' };
/** What we persist, keyed the way the rest of the CLI names a bearer token. */
const minted = { accessToken: 'hmok_new', publicId: 'ac_new' };

function credentialPath(): string {
  return join(process.env.HOOKMYAPP_CONFIG_DIR!, 'mcp-credential.json');
}

describe('the token handed to MCP clients', () => {
  const originalConfigDir = process.env.HOOKMYAPP_CONFIG_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    // Its own config dir per test: the credential is a real file now, so the
    // tests must not read or write the developer's own.
    process.env.HOOKMYAPP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hookmyapp-mcp-cred-'));
  });

  // Restore it: vitest may share a worker between files, and a leaked config
  // dir would silently repoint every later test's persisted config.
  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.HOOKMYAPP_CONFIG_DIR;
    else process.env.HOOKMYAPP_CONFIG_DIR = originalConfigDir;
  });

  test('mints an org credential rather than handing over the session JWT', async () => {
    // The JWT has no `aud` claim, so /mcp rejects it — that was the bug.
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(mintResponse);

    const token = await getMcpAccessToken();

    expect(token).toBe('hmok_new');
    expect(vi.mocked(apiClient).mock.calls.at(-1)?.[0]).toBe('/agent/credentials');
    expect(vi.mocked(apiClient).mock.calls.at(-1)?.[1]).toMatchObject({ method: 'POST' });
  });

  test('stores the minted key in its own file, not on the session record', async () => {
    // A mint must never rewrite credentials.json, or a logout landing mid-mint
    // gets undone by this write.
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(mintResponse);

    await getMcpAccessToken();

    expect(JSON.parse(readFileSync(credentialPath(), 'utf-8'))).toEqual(minted);
  });

  // POSIX only: chmod cannot express owner-only on Windows, where it toggles
  // the read-only bit and the mode reads back 0o666. credentials.json has the
  // same platform limit, so this is the existing security model, not a new gap.
  test.skipIf(process.platform === 'win32')('stores it owner-only', async () => {
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(mintResponse);

    await getMcpAccessToken();

    expect(statSync(credentialPath()).mode & 0o777).toBe(0o600);
  });

  test('reuses a stored key and makes no network call', async () => {
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    writeFileSync(credentialPath(), JSON.stringify({ accessToken: 'hmok_old', publicId: 'ac_old' }));

    expect(await getMcpAccessToken()).toBe('hmok_old');
    expect(apiClient).not.toHaveBeenCalled();
  });

  test('re-mints when the stored file is corrupt rather than serving junk', async () => {
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    writeFileSync(credentialPath(), '{ not json');
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(mintResponse);

    expect(await getMcpAccessToken()).toBe('hmok_new');
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
      .mockResolvedValueOnce(mintResponse);

    await getMcpAccessToken();

    const deletes = vi.mocked(apiClient).mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe('/agent/credentials/ac_old');
  });

  test('still mints when the key list cannot be read', async () => {
    // An older backend, or an offline blip on the list call, must not stop the
    // user getting the credential they asked for.
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(mintResponse);

    expect(await getMcpAccessToken()).toBe('hmok_new');
  });

  test('fails loudly when the mint returns nothing usable', async () => {
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce({});

    await expect(getMcpAccessToken()).rejects.toThrow(/did not return an org credential/);
    expect(existsSync(credentialPath())).toBe(false);
  });

  test('rejects a mint response whose fields are not strings', async () => {
    // A truthy check would pass this and then stringify an object into a
    // Bearer header, storing a publicId logout could never revoke.
    vi.mocked(readCredentials).mockResolvedValue(workosSession);
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ token: {}, publicId: {} });

    await expect(getMcpAccessToken()).rejects.toThrow(/did not return an org credential/);
    expect(existsSync(credentialPath())).toBe(false);
  });

  test("sweeps every key wearing this machine's name, not just one", async () => {
    // Two first-use mints racing each other leave a key the file never
    // recorded; logout revokes by name so that orphan cannot outlive it.
    const name = credentialName();
    vi.mocked(apiClient).mockResolvedValueOnce([
      { publicId: 'ac_a', name },
      { publicId: 'ac_b', name },
      { publicId: 'ac_other', name: 'someone-elses-laptop (HookMyApp CLI)' },
    ]);

    await revokeKeysForThisMachine();

    const deleted = vi
      .mocked(apiClient)
      .mock.calls.filter((c) => c[1]?.method === 'DELETE')
      .map((c) => c[0]);
    expect(deleted).toEqual(['/agent/credentials/ac_a', '/agent/credentials/ac_b']);
  });

  test('treats a non-array key list as nothing to sweep instead of throwing', async () => {
    // apiClient is untyped. A successful non-array body used to throw out of
    // the sweep, and the sweep runs inside logout BEFORE the local credentials
    // are deleted — so that throw left the user logged in.
    vi.mocked(apiClient).mockResolvedValueOnce({ error: 'nope' });

    await expect(revokeKeysForThisMachine()).resolves.toBe(0);
  });

  test('revokes a key that outlived the logout it raced, rather than storing it', async () => {
    // Logout sweeps this machine's keys, then our POST creates one the sweep
    // never saw. That key is live, not stale, and the machine is logged out.
    vi.mocked(readCredentials)
      .mockResolvedValueOnce(workosSession)
      .mockResolvedValueOnce(null);
    vi.mocked(apiClient).mockResolvedValueOnce([]).mockResolvedValueOnce(mintResponse);

    await expect(getMcpAccessToken()).rejects.toThrow(/Logged out while setting up/);

    expect(existsSync(credentialPath())).toBe(false);
    const deletes = vi.mocked(apiClient).mock.calls.filter((c) => c[1]?.method === 'DELETE');
    expect(deletes.map((c) => c[0])).toEqual(['/agent/credentials/ac_new']);
  });

  test('revokes the outgoing session\'s key, not just the local record', async () => {
    // Called before a login writes the new session. Unlinking the file alone
    // leaves the old account's key live for good: the next mint authenticates
    // as the NEW session, so its by-name sweep cannot see it.
    writeFileSync(credentialPath(), JSON.stringify(minted));

    await revokePreviousMcpCredential();

    expect(vi.mocked(apiClient)).toHaveBeenCalledWith(
      '/agent/credentials/ac_new',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(readMcpCredential()).toBeNull();
  });

  test('forgets the local copy even when the revoke cannot go out', async () => {
    // Offline, or an expired outgoing session. The key does not belong to the
    // session about to be written either way, and a login must not be blocked.
    writeFileSync(credentialPath(), JSON.stringify(minted));
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('offline'));

    await expect(revokePreviousMcpCredential()).resolves.toBeUndefined();
    expect(readMcpCredential()).toBeNull();
  });

  test('does nothing when there is no previous key', async () => {
    await revokePreviousMcpCredential();

    expect(apiClient).not.toHaveBeenCalled();
  });

  test('deleting the local copy leaves no file behind and is safe to repeat', () => {
    writeFileSync(credentialPath(), JSON.stringify(minted));

    deleteMcpCredential();
    deleteMcpCredential();

    expect(readMcpCredential()).toBeNull();
  });

  test('keeps the credential name inside the 60-character server limit', () => {
    expect(credentialName('a'.repeat(80)).length).toBeLessThanOrEqual(60);
  });
});
