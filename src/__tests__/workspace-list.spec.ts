import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hookmyapp-list-'));
const CONFIG_DIR = path.join(TMP_HOME, '.hookmyapp');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;
process.env.HOME = TMP_HOME;
process.env.HOOKMYAPP_CONFIG_DIR = CONFIG_DIR;

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn(),
}));

vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
  saveCredentials: vi.fn(),
}));

import { apiClient } from '../api/client.js';
const mockedApi = vi.mocked(apiClient);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

const CONFIG_PATH = path.join(TMP_HOME, '.hookmyapp', 'config.json');

// Phase 117: every workspace id fixture is a ws_ publicId.
const fakeWorkspaces = [
  { id: 'ws_TEST0001', name: 'Acme', workosOrganizationId: 'org_01A', role: 'admin', createdAt: '2026-01-01' },
  { id: 'ws_TEST0002', name: 'Globex', workosOrganizationId: 'org_01B', role: 'member', createdAt: '2026-02-01' },
];

beforeEach(async () => {
  vi.resetModules();
  mockedApi.mockReset();
  mockConsoleLog.mockClear();
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001', activeWorkspaceSlug: 'Acme' }));
});

afterEach(() => {
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
});

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_CONFIG_DIR !== undefined) {
    process.env.HOOKMYAPP_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  } else {
    delete process.env.HOOKMYAPP_CONFIG_DIR;
  }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function runList(extra: string[] = [], human = false): Promise<void> {
  const { Command } = await import('commander');
  const { registerWorkspaceCommand } = await import('../commands/workspace.js');
  const program = new Command();
  program.option('--human');
  registerWorkspaceCommand(program);
  const args = human ? ['--human', 'workspace', 'list', ...extra] : ['workspace', 'list', ...extra];
  await program.parseAsync(args, { from: 'user' });
}

describe('workspace list (RBAC-UX-04)', () => {
  it('human mode renders table with ACTIVE/NAME/SLUG/ROLE columns and * on active row', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runList([], true);

    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('ACTIVE');
    expect(logs).toContain('NAME');
    expect(logs).toContain('SLUG');
    expect(logs).toContain('ROLE');
    // Active marker on Acme row — cli-table3 renders with box-drawing
    // separators between cells, so we no longer assert a tab character.
    expect(logs).toContain('Acme');
    expect(logs).toMatch(/\*[^\n]*Acme/);
  });

  it('--json flag emits JSON array containing workosOrganizationId', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runList(['--json'], false);

    const lastCall = mockConsoleLog.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const parsed = JSON.parse(String(lastCall![0]));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ id: 'ws_TEST0001', workosOrganizationId: 'org_01A', role: 'admin' });
  });
});
