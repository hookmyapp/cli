import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readCredentials, readEnvCredential } from '../store.js';
import { API_KEY_ENV_VAR } from '../../config/env-vars.js';
import * as secrets from '../../storage/secrets.js';
import { AuthError } from '../../output/error.js';

const STORED = {
  accessToken: 'stored-token',
  refreshToken: 'r',
  expiresAt: 0,
} as const;

describe('HOOKMYAPP_API_KEY credential (AIT-438)', () => {
  const original = process.env[API_KEY_ENV_VAR];

  beforeEach(() => {
    delete process.env[API_KEY_ENV_VAR];
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (original === undefined) delete process.env[API_KEY_ENV_VAR];
    else process.env[API_KEY_ENV_VAR] = original;
  });

  it('is used when no credential is stored', async () => {
    vi.spyOn(secrets, 'readSecrets').mockResolvedValue(null);
    process.env[API_KEY_ENV_VAR] = 'hmok_abc123';
    const creds = await readCredentials();
    expect(creds?.accessToken).toBe('hmok_abc123');
    // Shaped as an agent credential so refresh/rescope stay no-ops.
    expect(creds?.kind).toBe('agent');
    expect(creds?.source).toBe('env');
  });

  it('outranks a stored credential', async () => {
    vi.spyOn(secrets, 'readSecrets').mockResolvedValue({ ...STORED });
    process.env[API_KEY_ENV_VAR] = 'hmok_abc123';
    expect((await readCredentials())?.accessToken).toBe('hmok_abc123');
  });

  it('leaves the stored credential in charge when unset', async () => {
    vi.spyOn(secrets, 'readSecrets').mockResolvedValue({ ...STORED });
    const creds = await readCredentials();
    expect(creds?.accessToken).toBe('stored-token');
    expect(creds?.source).toBeUndefined();
  });

  it('accepts legacy ac_ keys, which the backend still resolves', () => {
    process.env[API_KEY_ENV_VAR] = 'ac_legacy';
    expect(readEnvCredential()?.accessToken).toBe('ac_legacy');
  });

  it('ignores an empty or whitespace-only value', () => {
    process.env[API_KEY_ENV_VAR] = '   ';
    expect(readEnvCredential()).toBeNull();
  });

  // `set HOOKMYAPP_API_KEY=""` on cmd.exe stores the two quote characters.
  // Every caller must agree that is "unset", or login refuses while no
  // credential exists.
  it.each(['""', "''", '"   "'])('treats %s as unset everywhere', async (value) => {
    process.env[API_KEY_ENV_VAR] = value;
    expect(readEnvCredential()).toBeNull();
    const { envApiKey } = await import('../../config/env-vars.js');
    expect(envApiKey()).toBe('');
  });

  // cmd.exe keeps the quotes in `set HOOKMYAPP_API_KEY="hmok_abc"`, unlike
  // PowerShell and POSIX shells — without stripping, Windows users get
  // "not a valid API key" for a key that plainly starts with hmok_.
  it('accepts a value quoted the way cmd.exe stores it', () => {
    process.env[API_KEY_ENV_VAR] = '"hmok_abc123"';
    expect(readEnvCredential()?.accessToken).toBe('hmok_abc123');
    process.env[API_KEY_ENV_VAR] = "'hmok_abc123'";
    expect(readEnvCredential()?.accessToken).toBe('hmok_abc123');
  });

  it('leaves an unbalanced quote alone, so it still fails as malformed', () => {
    process.env[API_KEY_ENV_VAR] = '"hmok_abc123';
    expect(() => readEnvCredential()).toThrow(AuthError);
  });

  it('gives each env key its own notification-cache fingerprint', async () => {
    const { credentialFingerprint } = await import('../../notifications-nudge.js');
    const a = credentialFingerprint({
      accessToken: 'hmok_keyA', refreshToken: '', expiresAt: 0, kind: 'agent', source: 'env',
    });
    const b = credentialFingerprint({
      accessToken: 'hmok_keyB', refreshToken: '', expiresAt: 0, kind: 'agent', source: 'env',
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe('unknown');
    // Derived, never the secret itself.
    expect(a).not.toContain('hmok_keyA');
  });

  it('rejects a malformed value, naming the variable', () => {
    process.env[API_KEY_ENV_VAR] = 'not-a-key';
    expect(() => readEnvCredential()).toThrow(AuthError);
    expect(() => readEnvCredential()).toThrow(/HOOKMYAPP_API_KEY/);
  });

  it('never echoes the key in the malformed-value error', () => {
    process.env[API_KEY_ENV_VAR] = 'not-a-key-supersecret';
    try {
      readEnvCredential();
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('supersecret');
    }
  });
});
