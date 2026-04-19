import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Forks a fresh HOOKMYAPP_CONFIG_DIR per test so vitest.setup.ts's shared
// tmp dir doesn't leak state between tests in this file.
let CONFIG_DIR: string;
const SAVED_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;

function base64UrlJson(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64');
  const body = base64UrlJson(payload);
  return `${header}.${body}.signature-ignored`;
}

function writeCreds(creds: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'credentials.json'), JSON.stringify(creds));
}

function writeWorkspaceCfg(cfg: {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
}): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hookmyapp-bootstrap-test-'));
  process.env.HOOKMYAPP_CONFIG_DIR = CONFIG_DIR;
});

afterEach(() => {
  if (existsSync(CONFIG_DIR)) {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  }
  if (SAVED_CONFIG_DIR !== undefined) {
    process.env.HOOKMYAPP_CONFIG_DIR = SAVED_CONFIG_DIR;
  } else {
    delete process.env.HOOKMYAPP_CONFIG_DIR;
  }
});

describe('peekIdentity()', () => {
  test('returns null when no credentials file exists', async () => {
    const { peekIdentity } = await import('../store.js');
    expect(peekIdentity()).toBeNull();
  });

  test('returns null when credentials exist but no active workspace', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: buildJwt({ email: 'info@ordvir.com', exp: 9999999999 }),
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    // No config.json written — peekIdentity must return null rather than
    // falling back to a stale default.
    expect(peekIdentity()).toBeNull();
  });

  test('returns { email, workspaceSlug } when JWT carries email claim and workspace is active', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: buildJwt({ email: 'info@ordvir.com', exp: 9999999999 }),
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: "Or's Workspace",
    });
    expect(peekIdentity()).toEqual({
      email: 'info@ordvir.com',
      workspaceSlug: "Or's Workspace",
    });
  });

  test('returns null when JWT is malformed (no body segment)', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: 'not-a-jwt',
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: 'Anything',
    });
    expect(peekIdentity()).toBeNull();
  });

  test('returns null when JWT lacks an email claim', async () => {
    const { peekIdentity } = await import('../store.js');
    writeCreds({
      accessToken: buildJwt({ sub: 'usr_1', exp: 9999999999 }),
      refreshToken: 'r',
      expiresAt: 9999999999,
    });
    writeWorkspaceCfg({
      activeWorkspaceId: 'ws_ABCD1234',
      activeWorkspaceSlug: 'Anything',
    });
    expect(peekIdentity()).toBeNull();
  });
});

describe('hookmyapp login --code', () => {
  test.todo(
    '--code happy path: fetches /auth/bootstrap/exchange, saveCredentials, writeWorkspaceConfig, prints identity echo, calls runWizard',
  );
  test.todo(
    '--code + --wizard → ValidationError exit 2 (mutually exclusive)',
  );
  test.todo(
    '--code with prior identity present AND different → prints "was:" diff line before identity echo',
  );
  test.todo(
    '--code with prior identity present AND same → does NOT print "was:" diff line',
  );
  test.todo(
    '--code with 404 response → ApiError exitCode 5 with message matching /invalid or already used/i',
  );
  test.todo(
    '--code with 410 response → ApiError exitCode 5 with message matching /expired or already used/i',
  );
  test.todo('--code with 403 response → PermissionError exitCode 3');
  test.todo(
    '--code with 429 response → ConflictError exitCode 6, code "RATE_LIMITED"',
  );
  test.todo(
    'identity echo line format: ✓ Logged in as <email> — workspace "<name>" (exact em-dash, exact quote chars)',
  );
});
