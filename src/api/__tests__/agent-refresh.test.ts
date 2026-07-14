import { expect, test, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let DIR: string;
const SAVED = process.env.HOOKMYAPP_CONFIG_DIR;
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hma-agent-refresh-'));
  process.env.HOOKMYAPP_CONFIG_DIR = DIR;
  mkdirSync(DIR, { recursive: true });
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SAVED) process.env.HOOKMYAPP_CONFIG_DIR = SAVED;
  else delete process.env.HOOKMYAPP_CONFIG_DIR;
  vi.unstubAllGlobals();
});

test('forceTokenRefresh is a no-op for an agent credential (no WorkOS call)', async () => {
  writeFileSync(
    join(DIR, 'credentials.json'),
    JSON.stringify({ accessToken: 'ac_live_x', refreshToken: '', expiresAt: 0, kind: 'agent', credentialPublicId: 'ac_pub1', scopes: [] }),
  );
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const { forceTokenRefresh } = await import('../client.js');
  await expect(forceTokenRefresh()).resolves.toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
});
