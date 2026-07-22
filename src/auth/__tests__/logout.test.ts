import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { logoutCommand } from '../logout.js';

const removeClaudeMcpMock = vi.hoisted(() =>
  vi.fn<() => { ok: boolean; detail?: string }>(() => ({ ok: true })),
);
vi.mock('../../commands/mcp.js', () => ({ removeClaudeMcp: removeClaudeMcpMock }));

// logout against the real file-backed store in a temp HOOKMYAPP_CONFIG_DIR
// (same seam as agent-refresh.test.ts / the storage tests).

let DIR: string;
const SAVED = process.env.HOOKMYAPP_CONFIG_DIR;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  removeClaudeMcpMock.mockReset().mockReturnValue({ ok: true });
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

async function runLogout(args: string[] = []): Promise<void> {
  const program = new Command();
  // Mirror the root program's global --json flag so the action can read it.
  program.option('--json', 'machine-readable output');
  logoutCommand(program);
  await program.parseAsync(['node', 'hookmyapp', 'logout', ...args]);
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

  test('--json emits JSON, not the human check line (AIT-164)', async () => {
    const credsPath = join(DIR, 'credentials.json');
    writeFileSync(credsPath, JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 }));
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runLogout(['--json']);

    expect(existsSync(credsPath)).toBe(false);
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(JSON.parse(written.trim())).toEqual({
      status: 'logged_out',
      revoked: false,
      mcpCleanup: { ok: true },
    });
    // The human check line must NOT be printed in --json mode.
    expect(logSpy.mock.calls.flat().join('')).not.toMatch(/Logged out/);
  });

  test('reports MCP cleanup failure after credentials are removed', async () => {
    removeClaudeMcpMock.mockReturnValue({ ok: false, detail: 'Claude MCP cleanup timed out' });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runLogout(['--json']);

    expect(JSON.parse(String(stdoutSpy.mock.calls[0][0]))).toMatchObject({
      status: 'logged_out_with_warning',
      mcpCleanup: { ok: false, detail: 'Claude MCP cleanup timed out' },
    });
  });

  test('agent credential → self-revokes server-side before clearing local creds (AIT-153)', async () => {
    const credsPath = join(DIR, 'credentials.json');
    writeFileSync(
      credsPath,
      JSON.stringify({
        accessToken: 'ac_token',
        refreshToken: '',
        expiresAt: 0,
        kind: 'agent',
        credentialPublicId: 'ac_pub_1234',
      }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await runLogout();

    // Called DELETE on the self-revoke endpoint with the stored publicId.
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/agent/credentials/ac_pub_1234'),
    );
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ method: 'DELETE' });
    expect(existsSync(credsPath)).toBe(false);
    vi.unstubAllGlobals();
  });

  test('revoke failure still clears local credentials (AIT-153)', async () => {
    const credsPath = join(DIR, 'credentials.json');
    writeFileSync(
      credsPath,
      JSON.stringify({
        accessToken: 'ac_token',
        refreshToken: '',
        expiresAt: 0,
        kind: 'agent',
        credentialPublicId: 'ac_pub_9999',
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(runLogout()).resolves.toBeUndefined();

    expect(existsSync(credsPath)).toBe(false);
    expect(logSpy.mock.calls.flat().join('')).toMatch(/Logged out/);
    vi.unstubAllGlobals();
  });
});
