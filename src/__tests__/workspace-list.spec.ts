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
  rescopeWorkspaceToken: vi.fn().mockResolvedValue(undefined),
  setWorkspaceContext: vi.fn(),
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
// AIT-182: fixtures simulate an OLDER backend that still sends
// workosOrganizationId — the CLI must scrub it at the output boundary.
const fakeWorkspaces = [
  { id: 'ws_TEST0001', name: 'Acme', role: 'admin', createdAt: '2026-01-01', kind: 'team', workosOrganizationId: 'org_01INTERNAL' },
  { id: 'ws_TEST0002', name: 'Globex', role: 'member', createdAt: '2026-02-01', kind: 'customer', workosOrganizationId: 'org_01INTERNAL' },
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
  it('human mode renders table with ACTIVE/NAME/ID/ROLE columns and * on active row', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runList([], true);

    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('ACTIVE');
    expect(logs).toContain('NAME');
    expect(logs).toContain('ID');
    expect(logs).toContain('ROLE');
    // The WorkOS org id is a DROP-list field (spec 2026-05-27) — the column
    // now shows the ws_ publicId, not the internal WorkOS org id.
    expect(logs).toContain('ws_TEST0001');
    // Active marker on Acme row — cli-table3 renders with box-drawing
    // separators between cells, so we no longer assert a tab character.
    expect(logs).toContain('Acme');
    expect(logs).toMatch(/\*[^\n]*Acme/);
  });

  it('--json flag emits JSON array without the internal workosOrganizationId', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runList(['--json'], false);

    const lastCall = mockConsoleLog.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const parsed = JSON.parse(String(lastCall![0]));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ id: 'ws_TEST0001', role: 'admin' });
    expect(parsed[0]).not.toHaveProperty('workosOrganizationId');
  });

  it('is team-only: customer workspaces never appear (human mode)', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runList([], true);

    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('Acme');
    expect(logs).not.toContain('Globex');
  });

  it('is team-only in JSON mode too, and an unknown kind never renders as team', async () => {
    mockedApi.mockResolvedValue([
      ...fakeWorkspaces,
      { id: 'ws_TEST0003', name: 'Mystery', role: 'admin', createdAt: '2026-03-01', kind: 'weird' },
    ]);
    await runList(['--json'], false);

    const parsed = JSON.parse(String(mockConsoleLog.mock.calls.at(-1)![0]));
    expect(parsed.map((w: { id: string }) => w.id)).toEqual(['ws_TEST0001']);
  });
});
