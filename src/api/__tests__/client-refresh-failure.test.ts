import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError } from '../../output/error.js';

// Token-refresh FAILURE paths (AIT-50). Uses the real file-backed store in a
// temp HOOKMYAPP_CONFIG_DIR (same pattern as agent-refresh.test.ts) so we can
// assert the stored credentials are left uncorrupted when refresh fails —
// whether via 400/500 or via a malformed 200 body.

function expiredJwt(): string {
  // exp: 1 → long expired, forces apiClient's refresh path.
  const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString('base64');
  return `hdr.${payload}.sig`;
}

let DIR: string;
let STORED: string;
const SAVED = process.env.HOOKMYAPP_CONFIG_DIR;

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hma-refresh-fail-'));
  process.env.HOOKMYAPP_CONFIG_DIR = DIR;
  STORED = JSON.stringify(
    { accessToken: expiredJwt(), refreshToken: 'rt_original', expiresAt: 1 },
    null,
    2,
  );
  writeFileSync(join(DIR, 'credentials.json'), STORED);
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SAVED) process.env.HOOKMYAPP_CONFIG_DIR = SAVED;
  else delete process.env.HOOKMYAPP_CONFIG_DIR;
  vi.unstubAllGlobals();
});

function stubRefreshResponse(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function storedCredentials(): string {
  return readFileSync(join(DIR, 'credentials.json'), 'utf-8');
}

describe('apiClient — refresh endpoint returns an error status', () => {
  test.each([400, 500])(
    'expired credential + refresh %i → AuthError, stored credentials untouched',
    async (status) => {
      stubRefreshResponse(status, { error: 'invalid_grant' });
      const { apiClient } = await import('../client.js');

      const err = await apiClient('/workspaces').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toMatch(/Session expired/);
      expect(storedCredentials()).toBe(STORED);
    },
  );
});

describe('apiClient — refresh returns 200 with a malformed body', () => {
  test.each([
    ['missing fields', {}],
    ['empty-string tokens', { access_token: '', refresh_token: '' }],
    ['missing refresh_token', { access_token: expiredJwt() }],
  ])('%s → AuthError, no partial write to the store', async (_name, body) => {
    stubRefreshResponse(200, body);
    const { apiClient } = await import('../client.js');

    const err = await apiClient('/workspaces').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AuthError);
    expect(storedCredentials()).toBe(STORED);
  });
});

describe('forceTokenRefresh — refresh endpoint failure', () => {
  test('refresh 400 → AuthError, stored credentials untouched', async () => {
    stubRefreshResponse(400, { error: 'invalid_grant' });
    const { forceTokenRefresh } = await import('../client.js');

    await expect(forceTokenRefresh()).rejects.toBeInstanceOf(AuthError);
    expect(storedCredentials()).toBe(STORED);
  });
});
