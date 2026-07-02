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
  { id: 'ws_TEAM0001', name: 'HR', workosOrganizationId: 'org_01A', organizationPublicId: 'org_pub_A', role: 'admin', createdAt: '2026-01-01', kind: 'team' },
  { id: 'ws_CUST0001', name: 'Acme', workosOrganizationId: 'org_01A', organizationPublicId: 'org_pub_A', role: 'admin', createdAt: '2026-02-01', kind: 'customer' },
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

describe('customers new', () => {
  it('creates an empty customer via POST /organizations/:orgId/customers', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === '/workspaces') return fakeWorkspaces;
      return { id: 'ws_NEWCUST1', name: 'Fresh Client', externalId: 'crm-9' };
    });
    await runCustomers(['new', 'Fresh Client', '--external-id', 'crm-9']);

    expect(mockedApi).toHaveBeenCalledWith('/organizations/org_pub_A/customers', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fresh Client', externalId: 'crm-9' }),
    });
    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('ws_NEWCUST1');
  });

  it('does NOT switch the active workspace to the new customer', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ activeWorkspaceId: 'ws_TEAM0001', activeWorkspaceSlug: 'HR' }));
    mockedApi.mockImplementation(async (path: string) => {
      if (path === '/workspaces') return fakeWorkspaces;
      return { id: 'ws_NEWCUST1', name: 'Fresh Client', externalId: null };
    });
    await runCustomers(['new', 'Fresh Client']);

    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    expect(cfg.activeWorkspaceId).toBe('ws_TEAM0001');
  });
});

describe('customers onboarding-links', () => {
  it('list renders the org onboarding links', async () => {
    mockedApi.mockResolvedValue({
      links: [
        { publicId: 'ol_LINK0001', label: 'Acme', channelType: 'whatsapp', status: 'active' },
        { publicId: 'ol_LINK0002', label: 'Globex', channelType: 'instagram', status: 'revoked' },
      ],
    });
    await runCustomers(['onboarding-links', 'list']);

    expect(mockedApi).toHaveBeenCalledWith('/org/onboarding-links');
    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('Acme');
    expect(logs).toContain('revoked');
  });

  it('create posts label + channelType and prints the connect URL', async () => {
    mockedApi.mockResolvedValue({ publicId: 'ol_LINK0003', url: 'https://app.example/connect/tok123', token: 'tok123', verifyToken: 'vt' });
    await runCustomers(['onboarding-links', 'create', '--label', 'Acme', '--channel-type', 'whatsapp']);

    expect(mockedApi).toHaveBeenCalledWith('/org/onboarding-links', {
      method: 'POST',
      body: JSON.stringify({ label: 'Acme', channelType: 'whatsapp' }),
    });
    const logs = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('https://app.example/connect/tok123');
  });

  it('create rejects an invalid --channel-type', async () => {
    await expect(
      runCustomers(['onboarding-links', 'create', '--label', 'Acme', '--channel-type', 'sms']),
    ).rejects.toThrow(/--channel-type must be "whatsapp" or "instagram"/);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('create --customer targets an existing customer workspace', async () => {
    mockedApi.mockResolvedValue({ publicId: 'ol_LINK0004', url: 'https://app.example/connect/tok9' });
    await runCustomers([
      'onboarding-links', 'create',
      '--label', 'Acme', '--channel-type', 'whatsapp', '--customer', 'ws_CUST0001',
    ]);

    expect(mockedApi).toHaveBeenCalledWith('/org/onboarding-links', {
      method: 'POST',
      body: JSON.stringify({ label: 'Acme', channelType: 'whatsapp', targetWorkspaceId: 'ws_CUST0001' }),
    });
  });

  it('singular onboarding-link alias works', async () => {
    mockedApi.mockResolvedValue({ links: [] });
    await runCustomers(['onboarding-link', 'list']);
    expect(mockedApi).toHaveBeenCalledWith('/org/onboarding-links');
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
