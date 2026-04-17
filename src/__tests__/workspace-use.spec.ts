import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate CLI config so we don't clobber real ~/.hookmyapp/config.json (or
// other specs running in the same vitest process). Override both HOME and
// HOOKMYAPP_CONFIG_DIR — the CLI reads CONFIG_DIR first, other specs/vitest
// setup may have seeded it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hookmyapp-use-'));
const CONFIG_DIR = path.join(TMP_HOME, '.hookmyapp');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;
process.env.HOME = TMP_HOME;
process.env.HOOKMYAPP_CONFIG_DIR = CONFIG_DIR;

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({ accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
  saveCredentials: vi.fn(),
}));

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient, forceTokenRefresh } from '../api/client.js';
const mockedApi = vi.mocked(apiClient);
const mockedRefresh = vi.mocked(forceTokenRefresh);

const CONFIG_PATH = path.join(TMP_HOME, '.hookmyapp', 'config.json');

const fakeWorkspaces = [
  { id: 'ws_TEST0001', name: 'Acme', workosOrganizationId: 'org_01A', role: 'admin', createdAt: '2026-01-01' },
  { id: 'ws_TEST0002', name: 'Globex', workosOrganizationId: 'org_01B', role: 'member', createdAt: '2026-02-01' },
];

let originalIsTTY: boolean | undefined;

beforeEach(async () => {
  vi.resetModules();
  mockedApi.mockReset();
  mockedRefresh.mockReset();
  mockedRefresh.mockResolvedValue(undefined);
  mockConsoleLog.mockClear();
  originalIsTTY = process.stdout.isTTY;
});

afterEach(() => {
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
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

async function runWorkspaceUse(args: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerWorkspaceCommand } = await import('../commands/workspace.js');
  const program = new Command();
  program.option('--human');
  registerWorkspaceCommand(program);
  await program.parseAsync(['workspace', 'use', ...args], { from: 'user' });
}

describe('workspace use (RBAC-UX-01/02/03)', () => {
  it('RBAC-UX-01: resolves name and persists activeWorkspaceId + activeWorkspaceSlug', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runWorkspaceUse(['Acme']);

    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(cfg.activeWorkspaceId).toBe('ws_TEST0001');
    expect(cfg.activeWorkspaceSlug).toBe('Acme');
  });

  it('RBAC-UX-03: calls forceTokenRefresh(workosOrganizationId) after persist', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runWorkspaceUse(['Acme']);
    expect(mockedRefresh).toHaveBeenCalledWith('org_01A');
  });

  it('RBAC-UX-02: no-arg TTY uses @inquirer/prompts select and switches', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    mockedApi.mockResolvedValue(fakeWorkspaces);
    const { select } = await import('@inquirer/prompts');
    vi.mocked(select).mockResolvedValue('ws_TEST0002');

    await runWorkspaceUse([]);

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        choices: expect.arrayContaining([
          expect.objectContaining({ value: 'ws_TEST0001' }),
          expect.objectContaining({ value: 'ws_TEST0002' }),
        ]),
      }),
    );
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(cfg.activeWorkspaceId).toBe('ws_TEST0002');
    expect(mockedRefresh).toHaveBeenCalledWith('org_01B');
  });

  it('RBAC-UX-02: no-arg non-TTY throws ValidationError with exitCode 2', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    mockedApi.mockResolvedValue(fakeWorkspaces);

    await expect(runWorkspaceUse([])).rejects.toMatchObject({
      exitCode: 2,
      code: 'VALIDATION_ERROR',
    });
  });
});
