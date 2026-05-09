import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

// Fork an isolated config dir so tests never touch ~/.config/hookmyapp or ~/.hookmyapp.
let TEST_CONFIG_DIR: string;
const SAVED_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;

// Import after env vars are in place. We import at the top level so vitest
// resolves the module once (HOOKMYAPP_DISABLE_KEYCHAIN from setup.ts is already set).
import { saveCredentials, readCredentials, deleteCredentials } from '../auth/store.js';

describe('credential store (async)', () => {
  beforeEach(() => {
    TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hookmyapp-store-test-'));
    process.env.HOOKMYAPP_CONFIG_DIR = TEST_CONFIG_DIR;
  });

  afterEach(() => {
    rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    if (SAVED_CONFIG_DIR !== undefined) {
      process.env.HOOKMYAPP_CONFIG_DIR = SAVED_CONFIG_DIR;
    } else {
      delete process.env.HOOKMYAPP_CONFIG_DIR;
    }
  });

  it('saveCredentials writes credentials.json with the supplied values', async () => {
    const creds = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1234567890 };
    await saveCredentials(creds);

    const filePath = join(TEST_CONFIG_DIR, 'credentials.json');
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual(creds);
  });

  it('readCredentials returns parsed credentials when file exists', async () => {
    const creds = { accessToken: 'at2', refreshToken: 'rt2', expiresAt: 9999999 };
    await saveCredentials(creds);

    const result = await readCredentials();
    expect(result).toEqual(creds);
  });

  it('readCredentials returns null when no credentials exist', async () => {
    const result = await readCredentials();
    expect(result).toBeNull();
  });

  it('deleteCredentials removes the credentials file', async () => {
    const creds = { accessToken: 'at3', refreshToken: 'rt3', expiresAt: 1 };
    await saveCredentials(creds);

    await deleteCredentials();

    const result = await readCredentials();
    expect(result).toBeNull();
  });
});
