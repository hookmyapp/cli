import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSecrets, readSecrets, deleteSecrets } from '../secrets.js';

const FIXTURE = {
  accessToken: 'access-aaa',
  refreshToken: 'refresh-bbb',
  expiresAt: 1730000000000,
};

describe('secrets (file fallback path under HOOKMYAPP_DISABLE_KEYCHAIN=1)', () => {
  let dir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'secrets-test-'));
    originalConfigDir = process.env.HOOKMYAPP_CONFIG_DIR;
    process.env.HOOKMYAPP_CONFIG_DIR = dir;
    process.env.HOOKMYAPP_DISABLE_KEYCHAIN = '1';
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) process.env.HOOKMYAPP_CONFIG_DIR = originalConfigDir;
    else delete process.env.HOOKMYAPP_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeSecrets + readSecrets round-trips via the file fallback', async () => {
    await writeSecrets(FIXTURE);
    expect(await readSecrets()).toEqual(FIXTURE);
  });

  it('writes the file with mode 0o600', async () => {
    await writeSecrets(FIXTURE);
    const mode = statSync(join(dir, 'credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readSecrets returns null when no file exists', async () => {
    expect(await readSecrets()).toBeNull();
  });

  it('deleteSecrets removes the file', async () => {
    await writeSecrets(FIXTURE);
    expect(existsSync(join(dir, 'credentials.json'))).toBe(true);
    await deleteSecrets();
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false);
  });

  it('readSecrets returns null when file is corrupt JSON', async () => {
    writeFileSync(join(dir, 'credentials.json'), 'not json');
    expect(await readSecrets()).toBeNull();
  });
});
