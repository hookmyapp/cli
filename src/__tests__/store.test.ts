import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Override homedir so tests use a temp directory. vitest.setup.ts normally
// redirects via HOOKMYAPP_CONFIG_DIR, but this file specifically exercises
// the homedir() fallback path — scoped to this file only (saved/restored
// per-test via beforeEach/afterEach so sibling test files keep their
// setup-file-provided override).
const TEST_HOME = join(tmpdir(), `hookmyapp-test-${process.pid}`);
const SAVED_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

// Import after mock is set up
const { saveCredentials, readCredentials, deleteCredentials } = await import('../auth/store.js');

describe('credential store', () => {
  beforeEach(() => {
    delete process.env.HOOKMYAPP_CONFIG_DIR;
    mkdirSync(TEST_HOME, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
    if (SAVED_CONFIG_DIR !== undefined) {
      process.env.HOOKMYAPP_CONFIG_DIR = SAVED_CONFIG_DIR;
    }
  });

  it('saveCredentials writes JSON to ~/.hookmyapp/credentials.json with 0o600 permissions', () => {
    const creds = { accessToken: 'at', refreshToken: 'rt', expiresAt: 1234567890 };
    saveCredentials(creds);

    const filePath = join(TEST_HOME, '.hookmyapp', 'credentials.json');
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content).toEqual(creds);

    const stats = statSync(filePath);
    // 0o600 = owner read/write only (33152 on most systems)
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('readCredentials returns parsed JSON when file exists', () => {
    const creds = { accessToken: 'at2', refreshToken: 'rt2', expiresAt: 9999999 };
    const dir = join(TEST_HOME, '.hookmyapp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify(creds));

    const result = readCredentials();
    expect(result).toEqual(creds);
  });

  it('readCredentials returns null when file does not exist', () => {
    const result = readCredentials();
    expect(result).toBeNull();
  });

  it('deleteCredentials removes the credentials file', () => {
    const dir = join(TEST_HOME, '.hookmyapp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'credentials.json'), '{}');

    deleteCredentials();

    expect(() => readFileSync(join(dir, 'credentials.json'))).toThrow();
  });
});
