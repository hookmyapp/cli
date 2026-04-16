import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
}));

// Mock output
vi.mock('../output/format.js', () => ({
  output: vi.fn(),
}));

// Mock store
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({ accessToken: 'test-token', refreshToken: 'test-refresh' }),
  saveCredentials: vi.fn(),
}));

// Mock process.exit (still needed for process.exit(0) confirmation gates)
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit called');
}) as any);

const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);

const fakeWorkspaces = [
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Alpha Workspace', role: 'owner', createdAt: '2026-01-01' },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Beta Workspace', role: 'member', createdAt: '2026-02-01' },
  { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Beta Workspace', role: 'admin', createdAt: '2026-03-01' },
];

const fakeWorkspaceDetail = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Alpha Workspace',
  memberCount: 3,
  channelCount: 2,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-15',
};

describe('resolveWorkspace', () => {
  let resolveWorkspace: typeof import('../commands/workspace.js').resolveWorkspace;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockExit.mockClear();

    const mod = await import('../commands/workspace.js');
    resolveWorkspace = mod.resolveWorkspace;
  });

  it('resolves workspace by UUID', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const result = await resolveWorkspace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result).toEqual(fakeWorkspaces[0]);
  });

  it('resolves workspace by case-insensitive name', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const result = await resolveWorkspace('alpha workspace');
    expect(result).toEqual(fakeWorkspaces[0]);
  });

  it('throws CliError when workspace name is ambiguous', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const { CliError } = await import('../output/error.js');
    await expect(resolveWorkspace('Beta Workspace')).rejects.toThrow(CliError);
    await expect(resolveWorkspace('Beta Workspace')).rejects.toThrow('multiple workspaces');
  });

  it('throws CliError when workspace not found', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const { CliError } = await import('../output/error.js');
    await expect(resolveWorkspace('Nonexistent')).rejects.toThrow(CliError);
    await expect(resolveWorkspace('Nonexistent')).rejects.toThrow('not found');
  });
});

// Regression: config.json is a shared file — workspace.ts and
// env-profiles.ts each persist a slice of it. writeWorkspaceConfig must NOT
// clobber the env-profiles slice (specifically the `env` field), or the
// post-login wizard silently drops the user's `config set env local`
// choice and subsequent calls hit production. See debug session
// cli-sandbox-sessions-404.
describe('writeWorkspaceConfig config-file merge', () => {
  let writeWorkspaceConfig: typeof import('../commands/workspace.js').writeWorkspaceConfig;
  let readWorkspaceConfig: typeof import('../commands/workspace.js').readWorkspaceConfig;
  let setPersistedEnv: typeof import('../config/env-profiles.js').setPersistedEnv;
  let getPersistedEnv: typeof import('../config/env-profiles.js').getPersistedEnv;

  beforeEach(async () => {
    vi.resetModules();
    const wsMod = await import('../commands/workspace.js');
    writeWorkspaceConfig = wsMod.writeWorkspaceConfig;
    readWorkspaceConfig = wsMod.readWorkspaceConfig;
    const envMod = await import('../config/env-profiles.js');
    setPersistedEnv = envMod.setPersistedEnv;
    getPersistedEnv = envMod.getPersistedEnv;

    // Clean slate between tests — delete the shared config file.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const configDir = process.env.HOOKMYAPP_CONFIG_DIR ?? path.join(os.homedir(), '.hookmyapp');
    const configPath = path.join(configDir, 'config.json');
    try { fs.unlinkSync(configPath); } catch { /* noop */ }
  });

  it('preserves env field when writing workspace fields after config set env', () => {
    // Simulate: hookmyapp config set env local
    setPersistedEnv('local');
    expect(getPersistedEnv()).toBe('local');

    // Simulate: hookmyapp login → wizard persists active workspace
    writeWorkspaceConfig({
      activeWorkspaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      activeWorkspaceSlug: 'Test Workspace',
    });

    // env MUST still be local — otherwise subsequent apiClient calls
    // fall back to DEFAULT_ENV='production' and hit the wrong backend.
    expect(getPersistedEnv()).toBe('local');
    const ws = readWorkspaceConfig();
    expect(ws.activeWorkspaceId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(ws.activeWorkspaceSlug).toBe('Test Workspace');
  });

  it('preserves workspace fields when env-profiles rewrites env', () => {
    writeWorkspaceConfig({
      activeWorkspaceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      activeWorkspaceSlug: 'Another Workspace',
    });

    setPersistedEnv('staging');

    expect(getPersistedEnv()).toBe('staging');
    const ws = readWorkspaceConfig();
    expect(ws.activeWorkspaceId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(ws.activeWorkspaceSlug).toBe('Another Workspace');
  });
});

describe('workspace commands', () => {
  let registerWorkspaceCommand: typeof import('../commands/workspace.js').registerWorkspaceCommand;
  let writeWorkspaceConfig: typeof import('../commands/workspace.js').writeWorkspaceConfig;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockExit.mockClear();
    mockConsoleLog.mockClear();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/workspace.js');
    registerWorkspaceCommand = mod.registerWorkspaceCommand;
    writeWorkspaceConfig = mod.writeWorkspaceConfig;
  });

  describe('workspace new', () => {
    it('creates workspace and auto-switches to it (human mode)', async () => {
      const created = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'New WS', createdAt: '2026-04-01', updatedAt: '2026-04-01' };
      mockedApiClient.mockResolvedValue(created);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'new', 'New WS'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: 'New WS' }),
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Created workspace'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('New WS'));
    });

    it('outputs JSON under --json', async () => {
      const created = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'New WS', createdAt: '2026-04-01', updatedAt: '2026-04-01' };
      mockedApiClient.mockResolvedValue(created);

      const program = new Command();
      program.option('--human');
      program.option('--json');
      registerWorkspaceCommand(program);
      await program.parseAsync(['workspace', 'new', 'New WS', '--json'], { from: 'user' });

      // With --json flipped on, output should be called with human:false.
      expect(mockedOutput).toHaveBeenCalledWith(created, { human: false });
    });
  });

  describe('workspace current', () => {
    it('shows active workspace details', async () => {
      // First call: GET /workspaces (list with roles)
      mockedApiClient.mockResolvedValueOnce(fakeWorkspaces);
      // Second call: GET /workspaces/:id (detail with counts)
      mockedApiClient.mockResolvedValueOnce(fakeWorkspaceDetail);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      // We need to set active workspace config — but we can't easily mock fs in this context.
      // The command calls getDefaultWorkspaceId which reads config.
      // We mock the _helpers.js import inside workspace.ts.
      // Actually getDefaultWorkspaceId is imported dynamically. Let's mock it differently.

      // For this test we need active workspace set. Let's write config first.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? path.join(os.homedir(), '.hookmyapp'));
      const configPath = path.join(configDir, 'config.json');
      // Save original
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));

      try {
        await program.parseAsync(['workspace', 'current'], { from: 'user' });

        expect(mockedApiClient).toHaveBeenCalledWith('/workspaces');
        expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      } finally {
        // Restore original config
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });

    it('throws CliError when no active workspace', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? path.join(os.homedir(), '.hookmyapp'));
      const configPath = path.join(configDir, 'config.json');
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({}));

      try {
        // getDefaultWorkspaceId will try API fallback, which we make return empty
        mockedApiClient.mockResolvedValue([]);

        const program = new Command();
        program.option('--human');
        registerWorkspaceCommand(program);

        await expect(
          program.parseAsync(['workspace', 'current'], { from: 'user' }),
        ).rejects.toThrow(/not a member of any workspace/);
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });
  });

  describe('workspace rename', () => {
    it('renames active workspace (human mode)', async () => {
      const renamed = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Renamed WS', updatedAt: '2026-04-02' };
      mockedApiClient.mockResolvedValue(renamed);

      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(os.homedir(), '.hookmyapp'));
      const configPath = pathMod.join(configDir, 'config.json');
      fs.mkdirSync(configDir, { recursive: true });
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }
      fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));

      try {
        const program = new Command();
        program.option('--human');
        registerWorkspaceCommand(program);
        await program.parseAsync(['--human', 'workspace', 'rename', 'Renamed WS'], { from: 'user' });

        expect(mockedApiClient).toHaveBeenCalledWith(
          '/workspaces/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          {
            method: 'PATCH',
            body: JSON.stringify({ name: 'Renamed WS' }),
          },
        );
        expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Renamed workspace'));
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });
  });

  describe('workspace use with name', () => {
    it('resolves workspace by name and sets config', async () => {
      mockedApiClient.mockResolvedValue(fakeWorkspaces);

      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(os.homedir(), '.hookmyapp'));
      const configPath = pathMod.join(configDir, 'config.json');
      fs.mkdirSync(configDir, { recursive: true });
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }

      try {
        const program = new Command();
        program.option('--human');
        registerWorkspaceCommand(program);
        await program.parseAsync(['workspace', 'use', 'Alpha Workspace'], { from: 'user' });

        expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Alpha Workspace'));
        // Verify config was written
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(config.activeWorkspaceId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });

    it('workspace use still works with UUID', async () => {
      mockedApiClient.mockResolvedValue(fakeWorkspaces);

      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(os.homedir(), '.hookmyapp'));
      const configPath = pathMod.join(configDir, 'config.json');
      fs.mkdirSync(configDir, { recursive: true });
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }

      try {
        const program = new Command();
        program.option('--human');
        registerWorkspaceCommand(program);
        await program.parseAsync(['workspace', 'use', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'], { from: 'user' });

        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(config.activeWorkspaceId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });
  });
});

// ---- Plan 02: Member & Invite Commands ----

const fakeMembersResponse = {
  members: [
    { id: 'mem-1', userId: 'user-1', workspaceId: 'ws-1', role: 'owner', user: { id: 'user-1', email: 'owner@co.com', firstName: 'Owner', lastName: 'User' } },
    { id: 'mem-2', userId: 'user-2', workspaceId: 'ws-1', role: 'member', user: { id: 'user-2', email: 'member@co.com', firstName: 'Member', lastName: null } },
  ],
  invites: [
    { id: 'inv-1', email: 'pending@co.com', role: 'admin', workspaceId: 'ws-1', invitedBy: 'user-1', createdAt: '2026-01-01' },
  ],
};

describe('resolveMemberByEmail', () => {
  beforeEach(() => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockExit.mockClear();
  });

  it('finds member by email (case-insensitive)', async () => {
    mockedApiClient.mockResolvedValue(fakeMembersResponse);
    const { resolveMemberByEmail } = await import('../commands/workspace.js');
    const member = await resolveMemberByEmail('ws-1', 'OWNER@CO.COM');
    expect(member).toEqual(fakeMembersResponse.members[0]);
  });

  it('throws CliError when member not found', async () => {
    mockedApiClient.mockResolvedValue(fakeMembersResponse);
    const { resolveMemberByEmail } = await import('../commands/workspace.js');
    const { CliError } = await import('../output/error.js');
    await expect(resolveMemberByEmail('ws-1', 'unknown@co.com')).rejects.toThrow(CliError);
    await expect(resolveMemberByEmail('ws-1', 'unknown@co.com')).rejects.toThrow('member');
  });
});

describe('resolveInviteByIdOrEmail', () => {
  beforeEach(() => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockExit.mockClear();
  });

  it('finds invite by email', async () => {
    mockedApiClient.mockResolvedValue(fakeMembersResponse);
    const { resolveInviteByIdOrEmail } = await import('../commands/workspace.js');
    const invite = await resolveInviteByIdOrEmail('ws-1', 'pending@co.com');
    expect(invite).toEqual(fakeMembersResponse.invites[0]);
  });

  it('finds invite by UUID pattern', async () => {
    const responseWithUuidInvite = {
      members: [],
      invites: [
        { id: 'aabbccdd-1234-5678-abcd-aabbccddeeff', email: 'pending@co.com', role: 'admin', workspaceId: 'ws-1', invitedBy: 'user-1', createdAt: '2026-01-01' },
      ],
    };
    mockedApiClient.mockResolvedValue(responseWithUuidInvite);
    const { resolveInviteByIdOrEmail } = await import('../commands/workspace.js');
    const invite = await resolveInviteByIdOrEmail('ws-1', 'aabbccdd-1234-5678-abcd-aabbccddeeff');
    expect(invite).toEqual(responseWithUuidInvite.invites[0]);
  });

  it('throws CliError when invite not found', async () => {
    mockedApiClient.mockResolvedValue(fakeMembersResponse);
    const { resolveInviteByIdOrEmail } = await import('../commands/workspace.js');
    const { CliError } = await import('../output/error.js');
    await expect(resolveInviteByIdOrEmail('ws-1', 'unknown@co.com')).rejects.toThrow(CliError);
    await expect(resolveInviteByIdOrEmail('ws-1', 'unknown@co.com')).rejects.toThrow('invite');
  });
});

describe('workspace members commands', () => {
  let registerWorkspaceCommand: typeof import('../commands/workspace.js').registerWorkspaceCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockExit.mockClear();
    mockConsoleLog.mockClear();

    // Set active workspace config
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(osMod.homedir(), '.hookmyapp'));
    const configPath = pathMod.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws-1' }));

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/workspace.js');
    registerWorkspaceCommand = mod.registerWorkspaceCommand;
  });

  describe('members list', () => {
    it('merges members and invites with status column', async () => {
      mockedApiClient.mockResolvedValue(fakeMembersResponse);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['workspace', 'members', 'list'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/members');
      expect(mockedOutput).toHaveBeenCalledTimes(1);
      const rows = mockedOutput.mock.calls[0][0] as any[];
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ email: 'owner@co.com', role: 'owner', status: 'active' });
      expect(rows[1]).toMatchObject({ email: 'member@co.com', role: 'member', status: 'active' });
      expect(rows[2]).toMatchObject({ email: 'pending@co.com', role: 'admin', status: 'pending' });
    });
  });

  describe('members invite', () => {
    it('sends POST with default role member', async () => {
      mockedApiClient.mockResolvedValue({ id: 'inv-new', email: 'new@co.com', role: 'member' });

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'invite', 'new@co.com'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/members', {
        method: 'POST',
        body: JSON.stringify({ email: 'new@co.com', role: 'member' }),
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Invited'));
    });

    it('sends POST with --role admin', async () => {
      mockedApiClient.mockResolvedValue({ id: 'inv-new', email: 'new@co.com', role: 'admin' });

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'invite', 'new@co.com', '--role', 'admin'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/members', {
        method: 'POST',
        body: JSON.stringify({ email: 'new@co.com', role: 'admin' }),
      });
    });

    it('throws CliError for --role owner', async () => {
      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await expect(
        program.parseAsync(['workspace', 'members', 'invite', 'new@co.com', '--role', 'owner'], { from: 'user' }),
      ).rejects.toThrow('invalid role');
    });
  });

  describe('members remove', () => {
    it('without --yes prints dry-run and exits 0', async () => {
      mockedApiClient.mockResolvedValue(fakeMembersResponse);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await expect(
        program.parseAsync(['workspace', 'members', 'remove', 'member@co.com'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Would remove'));
    });

    it('with --yes resolves email and sends DELETE', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveMemberByEmail
        .mockResolvedValueOnce({ success: true }); // DELETE

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'remove', 'member@co.com', '--yes'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/members/mem-2', {
        method: 'DELETE',
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Removed'));
    });
  });

  describe('members role', () => {
    it('sends PATCH with correct role', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveMemberByEmail
        .mockResolvedValueOnce({ id: 'mem-2', role: 'admin' }); // PATCH

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'role', 'member@co.com', '--role', 'admin'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/members/mem-2', {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Updated'));
    });

    it('throws CliError for --role owner', async () => {
      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await expect(
        program.parseAsync(['workspace', 'members', 'role', 'member@co.com', '--role', 'owner'], { from: 'user' }),
      ).rejects.toThrow('invalid role');
    });
  });
});

describe('workspace invites commands', () => {
  let registerWorkspaceCommand: typeof import('../commands/workspace.js').registerWorkspaceCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockExit.mockClear();
    mockConsoleLog.mockClear();

    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(osMod.homedir(), '.hookmyapp'));
    const configPath = pathMod.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws-1' }));

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/workspace.js');
    registerWorkspaceCommand = mod.registerWorkspaceCommand;
  });

  describe('invites cancel', () => {
    it('without --yes prints dry-run and exits 0', async () => {
      mockedApiClient.mockResolvedValue(fakeMembersResponse);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await expect(
        program.parseAsync(['workspace', 'invites', 'cancel', 'pending@co.com'], { from: 'user' }),
      ).rejects.toThrow('process.exit called');
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Would cancel'));
    });

    it('with --yes and email resolves invite and sends DELETE', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveInviteByIdOrEmail
        .mockResolvedValueOnce({ success: true }); // DELETE

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'invites', 'cancel', 'pending@co.com', '--yes'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/invites/inv-1', {
        method: 'DELETE',
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    });

    it('with --yes and UUID resolves invite by ID and sends DELETE', async () => {
      const responseWithUuidInvite = {
        members: [],
        invites: [
          { id: 'aabbccdd-1234-5678-abcd-aabbccddeeff', email: 'pending@co.com', role: 'admin', workspaceId: 'ws-1', invitedBy: 'user-1', createdAt: '2026-01-01' },
        ],
      };
      mockedApiClient
        .mockResolvedValueOnce(responseWithUuidInvite) // resolveInviteByIdOrEmail
        .mockResolvedValueOnce({ success: true }); // DELETE

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'invites', 'cancel', 'aabbccdd-1234-5678-abcd-aabbccddeeff', '--yes'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws-1/invites/aabbccdd-1234-5678-abcd-aabbccddeeff', {
        method: 'DELETE',
      });
    });
  });
});
