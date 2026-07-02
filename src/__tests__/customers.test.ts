import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate CLI config (same pattern as workspace-use.spec.ts): override both
// HOME and HOOKMYAPP_CONFIG_DIR before importing the CLI modules.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hookmyapp-customers-'));
const CONFIG_DIR = path.join(TMP_HOME, '.hookmyapp');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CONFIG_DIR = process.env.HOOKMYAPP_CONFIG_DIR;
process.env.HOME = TMP_HOME;
process.env.HOOKMYAPP_CONFIG_DIR = CONFIG_DIR;

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
  setWorkspaceContext: vi.fn(),
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
  { id: 'ws_TEAM0001', name: 'HR', workosOrganizationId: 'org_01A', role: 'admin', createdAt: '2026-01-01', kind: 'team' },
  { id: 'ws_CUST0001', name: 'Acme', workosOrganizationId: 'org_01A', role: 'admin', createdAt: '2026-02-01', kind: 'customer' },
];

beforeEach(async () => {
  vi.resetModules();
  mockedApi.mockReset();
  mockedRefresh.mockReset();
  mockedRefresh.mockResolvedValue(undefined);
  mockConsoleLog.mockClear();
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

async function runCustomers(args: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerCustomersCommand } = await import('../commands/customers.js');
  const program = new Command();
  program.option('--human');
  registerCustomersCommand(program);
  await program.parseAsync(['customers', ...args], { from: 'user' });
}

describe('customers list', () => {
  it('lists only customer-kind workspaces (JSON mode)', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runCustomers(['list', '--json']);

    const parsed = JSON.parse(String(mockConsoleLog.mock.calls.at(-1)![0]));
    expect(parsed.map((w: { id: string }) => w.id)).toEqual(['ws_CUST0001']);
    expect(parsed[0].kind).toBe('customer');
  });

  it('human mode renders customer rows only', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runCustomers(['list']);

    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('Acme');
    expect(logs).not.toContain('HR');
  });
});

describe('customers use', () => {
  it('switches the active workspace to a customer by name', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runCustomers(['use', 'Acme']);

    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(cfg.activeWorkspaceId).toBe('ws_CUST0001');
    expect(mockedRefresh).toHaveBeenCalledWith('org_01A');
  });

  it('refuses to switch into a team workspace', async () => {
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await expect(runCustomers(['use', 'HR'])).rejects.toThrow(/not found/);
  });
});

describe('customers current', () => {
  it('shows the active workspace when it is a customer', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ activeWorkspaceId: 'ws_CUST0001', activeWorkspaceSlug: 'Acme' }));
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runCustomers(['current']);

    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('Acme');
    expect(logs).toContain('ws_CUST0001');
  });

  it('says so when the active workspace is not a customer', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ activeWorkspaceId: 'ws_TEAM0001', activeWorkspaceSlug: 'HR' }));
    mockedApi.mockResolvedValue(fakeWorkspaces);
    await runCustomers(['current']);

    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('not a customer');
  });
});
