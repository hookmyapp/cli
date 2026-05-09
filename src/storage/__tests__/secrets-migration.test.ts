import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyCredentials, readSecrets, __resetForTests } from '../secrets.js';

describe('migrateLegacyCredentials', () => {
  let legacyDir: string;
  let newDir: string;

  beforeEach(() => {
    legacyDir = mkdtempSync(join(tmpdir(), 'legacy-creds-'));
    newDir = mkdtempSync(join(tmpdir(), 'new-creds-'));
    process.env.HOOKMYAPP_CONFIG_DIR = newDir;
    process.env.HOOKMYAPP_DISABLE_KEYCHAIN = '1';
    __resetForTests();
  });

  afterEach(() => {
    rmSync(legacyDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it('copies legacy credentials.json to new file form, then deletes legacy', async () => {
    writeFileSync(
      join(legacyDir, 'credentials.json'),
      JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 999 }),
    );
    await migrateLegacyCredentials(legacyDir);
    const after = await readSecrets();
    expect(after).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 999 });
    expect(existsSync(join(legacyDir, 'credentials.json'))).toBe(false);
  });

  it('no-ops when no legacy creds file exists', async () => {
    await migrateLegacyCredentials(legacyDir);
    expect(await readSecrets()).toBeNull();
  });

  it('preserves legacy file when read-back verification fails', async () => {
    // Simulate verification failure by writing a corrupt file: writeSecrets
    // succeeds (file fallback) but if readSecrets returns null, helper must
    // NOT delete the source.
    writeFileSync(join(legacyDir, 'credentials.json'), 'not json');
    await migrateLegacyCredentials(legacyDir);
    expect(existsSync(join(legacyDir, 'credentials.json'))).toBe(true);
  });
});
