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

  it('rejects a malformed value, naming the variable', () => {
    process.env[API_KEY_ENV_VAR] = 'not-a-key';
    expect(() => readEnvCredential()).toThrow(AuthError);
    expect(() => readEnvCredential()).toThrow(/HOOKMYAPP_API_KEY/);
  });

  it('never echoes the key in the malformed-value error', () => {
    process.env[API_KEY_ENV_VAR] = 'sk_live_supersecret';
    try {
      readEnvCredential();
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('supersecret');
    }
  });
});
