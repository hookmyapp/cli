import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { logoutCommand } from '../logout.js';

// logout against the real file-backed store in a temp HOOKMYAPP_CONFIG_DIR
// (same seam as agent-refresh.test.ts / the storage tests).

let DIR: string;
const SAVED = process.env.HOOKMYAPP_CONFIG_DIR;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hma-logout-'));
  process.env.HOOKMYAPP_CONFIG_DIR = DIR;
  logSpy = vi.spyOn(console, 'log').mockReturnValue(undefined);
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SAVED) process.env.HOOKMYAPP_CONFIG_DIR = SAVED;
  else delete process.env.HOOKMYAPP_CONFIG_DIR;
  vi.restoreAllMocks();
});

async function runLogout(): Promise<void> {
  const program = new Command();
  logoutCommand(program);
  await program.parseAsync(['node', 'hookmyapp', 'logout']);
}

describe('logout', () => {
  test('removes the credentials file', async () => {
    const credsPath = join(DIR, 'credentials.json');
    writeFileSync(credsPath, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));

    await runLogout();

    expect(existsSync(credsPath)).toBe(false);
    expect(logSpy.mock.calls.flat().join('')).toMatch(/Logged out/);
  });

  test('already logged out → exits cleanly', async () => {
    expect(existsSync(join(DIR, 'credentials.json'))).toBe(false);

    await expect(runLogout()).resolves.toBeUndefined();
    expect(logSpy.mock.calls.flat().join('')).toMatch(/Logged out/);
  });
});
