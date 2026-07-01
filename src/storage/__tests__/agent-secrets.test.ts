import { expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let DIR: string;
const SAVED = process.env.HOOKMYAPP_CONFIG_DIR;
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hma-agent-secrets-'));
  process.env.HOOKMYAPP_CONFIG_DIR = DIR;
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SAVED) process.env.HOOKMYAPP_CONFIG_DIR = SAVED;
  else delete process.env.HOOKMYAPP_CONFIG_DIR;
});

test('round-trips an agent credential and flags it', async () => {
  const { writeSecrets, readSecrets, isAgentCredential } = await import('../secrets.js');
  await writeSecrets({
    accessToken: 'ac_abc',
    refreshToken: '',
    expiresAt: 0,
    kind: 'agent',
    credentialPublicId: 'ac_pub1',
    scopes: ['workspace.read'],
  });
  const got = await readSecrets();
  expect(got?.accessToken).toBe('ac_abc');
  expect(got?.credentialPublicId).toBe('ac_pub1');
  expect(isAgentCredential(got!)).toBe(true);
});

test('a legacy workos credential is not flagged as agent', async () => {
  const { isAgentCredential } = await import('../secrets.js');
  expect(isAgentCredential({ accessToken: 'ey.j.s', refreshToken: 'r', expiresAt: 123 })).toBe(false);
});
