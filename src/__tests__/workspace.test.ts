import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn().mockResolvedValue(undefined),
  rescopeWorkspaceToken: vi.fn().mockResolvedValue(undefined),
  setWorkspaceContext: vi.fn(),
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

import { apiClient, rescopeWorkspaceToken } from '../api/client.js';
import { output } from '../output/format.js';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);
const mockedRescopeWorkspaceToken = vi.mocked(rescopeWorkspaceToken);

// Phase 117 — every id fixture below is a publicId (ws_/ch_/ssn_/mem_/inv_ prefix, 8-char
// alphanumeric body). Raw UUIDs are rejected with a typed ValidationError at every
// external flag/header/body surface; see workspace.ts resolveWorkspace + _helpers.ts.
// AIT-182 — the workspaces wire no longer carries workosOrganizationId.
const fakeWorkspaces = [
  { id: 'ws_TEST0001', name: 'Alpha Workspace', role: 'owner', createdAt: '2026-01-01', kind: 'team' },
  { id: 'ws_TEST0002', name: 'Beta Workspace', role: 'member', createdAt: '2026-02-01', kind: 'team' },
  { id: 'ws_TEST0003', name: 'Beta Workspace', role: 'admin', createdAt: '2026-03-01', kind: 'team' },
];

const fakeWorkspaceDetail = {
  id: 'ws_TEST0001',
  name: 'Alpha Workspace',
  memberCount: 3,
  channelCount: 2,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-15',
  // AIT-182 rollout skew: an older backend may still send this — the CLI
  // must scrub it before output.
  workosOrganizationId: 'org_01INTERNAL',
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

  it('resolves workspace by ws_ publicId', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const result = await resolveWorkspace('ws_TEST0001');
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

  // Phase 117 hard cutover — raw UUID input is not an accepted shape.
  it('throws typed CliError when given a raw UUID (Phase 117 hard cutover)', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const { CliError } = await import('../output/error.js');
    await expect(resolveWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow(CliError);
    await expect(resolveWorkspace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow(/raw UUID/);
  });

  it('throws not-found when ws_ publicId is well-formed but unknown', async () => {
    mockedApiClient.mockResolvedValue(fakeWorkspaces);
    const { CliError } = await import('../output/error.js');
    await expect(resolveWorkspace('ws_NOPEXXX0')).rejects.toThrow(CliError);
    await expect(resolveWorkspace('ws_NOPEXXX0')).rejects.toThrow('not found');
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
      activeWorkspaceId: 'ws_TEST0001',
      activeWorkspaceSlug: 'Test Workspace',
    });

    // env MUST still be local — otherwise subsequent apiClient calls
    // fall back to DEFAULT_ENV='production' and hit the wrong backend.
    expect(getPersistedEnv()).toBe('local');
    const ws = readWorkspaceConfig();
    expect(ws.activeWorkspaceId).toBe('ws_TEST0001');
    expect(ws.activeWorkspaceSlug).toBe('Test Workspace');
  });

  it('preserves workspace fields when env-profiles rewrites env', () => {
    writeWorkspaceConfig({
      activeWorkspaceId: 'ws_TEST0002',
      activeWorkspaceSlug: 'Another Workspace',
    });

    setPersistedEnv('staging');

    expect(getPersistedEnv()).toBe('staging');
    const ws = readWorkspaceConfig();
    expect(ws.activeWorkspaceId).toBe('ws_TEST0002');
    expect(ws.activeWorkspaceSlug).toBe('Another Workspace');
  });

  // Phase 117 — readWorkspaceConfig silently drops a stale UUID activeWorkspaceId
  // (pre-0.5.0 install artifact). Prevents the UUID from leaking back out to the
  // backend which now 400s on every UUID input.
  it('silently drops stale UUID activeWorkspaceId on read (pre-0.5.0 config)', async () => {
    // Simulate a pre-0.5.0 install: write a raw UUID directly through the
    // underlying fs, bypassing writeWorkspaceConfig (which shares the file
    // with env-profiles). We only test the read path here.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const configDir = process.env.HOOKMYAPP_CONFIG_DIR ?? path.join(os.homedir(), '.hookmyapp');
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        activeWorkspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        activeWorkspaceSlug: 'Stale Workspace',
        env: 'staging',
      }) + '\n',
    );

    const ws = readWorkspaceConfig();
    expect(ws.activeWorkspaceId).toBeUndefined();
    expect(ws.activeWorkspaceSlug).toBeUndefined();
    // env slice untouched — owned by env-profiles.ts; must survive the read.
    expect(getPersistedEnv()).toBe('staging');
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
    // The create endpoint returns the public DTO (AIT-147/AIT-182): `id` IS
    // the ws_ publicId — no raw UUID, no workosOrganizationId on the wire.
    const created = {
      id: 'ws_TEST0004',
      name: 'New WS',
      createdAt: '2026-04-01',
      updatedAt: '2026-04-01',
    };

    it('creates workspace and auto-switches to it (human mode)', async () => {
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

    it('outputs a clean public DTO under --json (no raw UUID)', async () => {
      mockedApiClient.mockResolvedValue(created);

      const program = new Command();
      program.option('--human');
      program.option('--json');
      registerWorkspaceCommand(program);
      await program.parseAsync(['workspace', 'new', 'New WS', '--json'], { from: 'user' });

      // publicId-as-id, name only — never the raw `id` UUID.
      expect(mockedOutput).toHaveBeenCalledWith(
        { id: 'ws_TEST0004', name: 'New WS' },
        { human: false },
      );
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
      fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001' }));

      try {
        await program.parseAsync(['workspace', 'current'], { from: 'user' });

        expect(mockedApiClient).toHaveBeenCalledWith('/workspaces');
        expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001');
      } finally {
        // Restore original config
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });

    it('omits workosOrganizationId from --json output', async () => {
      mockedApiClient.mockResolvedValueOnce(fakeWorkspaces);
      mockedApiClient.mockResolvedValueOnce(fakeWorkspaceDetail);

      const program = new Command();
      program.option('--human').option('--json');
      registerWorkspaceCommand(program);

      const fs = await import('node:fs');
      const path = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? path.join(os.homedir(), '.hookmyapp'));
      const configPath = path.join(configDir, 'config.json');
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001' }));

      try {
        await program.parseAsync(['--json', 'workspace', 'current'], { from: 'user' });

        expect(mockedOutput).toHaveBeenCalledWith(
          expect.not.objectContaining({ workosOrganizationId: expect.anything() }),
          { human: false },
        );
      } finally {
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
      const renamed = { id: 'ws_TEST0001', name: 'Renamed WS', updatedAt: '2026-04-02' };
      mockedApiClient.mockResolvedValue(renamed);

      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(os.homedir(), '.hookmyapp'));
      const configPath = pathMod.join(configDir, 'config.json');
      fs.mkdirSync(configDir, { recursive: true });
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }
      fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001' }));

      try {
        const program = new Command();
        program.option('--human');
        registerWorkspaceCommand(program);
        await program.parseAsync(['--human', 'workspace', 'rename', 'Renamed WS'], { from: 'user' });

        expect(mockedApiClient).toHaveBeenCalledWith(
          '/workspaces/ws_TEST0001',
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

    it('outputs a clean public DTO under --json (no raw UUID)', async () => {
      // PATCH returns the public DTO (AIT-147): `id` is the ws_ publicId.
      mockedApiClient.mockResolvedValue({
        id: 'ws_TEST0001',
        name: 'Renamed WS',
        updatedAt: '2026-04-02',
      });

      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const os = await import('node:os');
      const configDir = (process.env.HOOKMYAPP_CONFIG_DIR ?? pathMod.join(os.homedir(), '.hookmyapp'));
      const configPath = pathMod.join(configDir, 'config.json');
      fs.mkdirSync(configDir, { recursive: true });
      let originalConfig: string | null = null;
      try { originalConfig = fs.readFileSync(configPath, 'utf-8'); } catch { /* noop */ }
      fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001' }));

      try {
        const program = new Command();
        program.option('--json');
        registerWorkspaceCommand(program);
        await program.parseAsync(['workspace', 'rename', 'Renamed WS', '--json'], { from: 'user' });

        expect(mockedOutput).toHaveBeenCalledWith(
          { id: 'ws_TEST0001', name: 'Renamed WS' },
          { human: false },
        );
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
        expect(config.activeWorkspaceId).toBe('ws_TEST0001');
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });

    it('re-scopes the token via the server rescope endpoint and emits a clean DTO under --json', async () => {
      mockedRescopeWorkspaceToken.mockClear();
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
        program.option('--json');
        registerWorkspaceCommand(program);
        await program.parseAsync(['workspace', 'use', 'Alpha Workspace', '--json'], { from: 'user' });

        // AIT-182 — the server resolves workspace → org; the CLI only sends
        // the ws_ publicId to POST /auth/rescope.
        expect(mockedRescopeWorkspaceToken).toHaveBeenCalledWith('ws_TEST0001');
        expect(mockedOutput).toHaveBeenCalledWith(
          { id: 'ws_TEST0001', name: 'Alpha Workspace' },
          { human: false },
        );
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });

    it('workspace use accepts ws_ publicId', async () => {
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
        await program.parseAsync(['workspace', 'use', 'ws_TEST0002'], { from: 'user' });

        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(config.activeWorkspaceId).toBe('ws_TEST0002');
      } finally {
        if (originalConfig !== null) {
          fs.writeFileSync(configPath, originalConfig);
        }
      }
    });

    // Phase 117 hard cutover — negative regression.
    it('workspace use rejects raw UUID with typed ValidationError', async () => {
      mockedApiClient.mockResolvedValue(fakeWorkspaces);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await expect(
        program.parseAsync(
          ['workspace', 'use', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
          { from: 'user' },
        ),
      ).rejects.toThrow(/raw UUID/);
    });
  });
});

// ---- Plan 02: Member & Invite Commands ----

const fakeMembersResponse = {
  members: [
    { id: 'mem_TEST001', role: 'owner', email: 'owner@co.com', firstName: 'Owner', lastName: 'User', joinedAt: 1735689600000, cliLastSeenAt: null },
    { id: 'mem_TEST002', role: 'member', email: 'member@co.com', firstName: 'Member', lastName: null, joinedAt: 1735689600000, cliLastSeenAt: null },
  ],
  invites: [
    { id: 'inv_TEST001', email: 'pending@co.com', role: 'admin', workspaceId: 'ws_TEST0001', invitedBy: 'usr_TEST001', createdAt: '2026-01-01' },
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
    const member = await resolveMemberByEmail('ws_TEST0001', 'OWNER@CO.COM');
    expect(member).toEqual(fakeMembersResponse.members[0]);
  });

  it('throws CliError when member not found', async () => {
    mockedApiClient.mockResolvedValue(fakeMembersResponse);
    const { resolveMemberByEmail } = await import('../commands/workspace.js');
    const { CliError } = await import('../output/error.js');
    await expect(resolveMemberByEmail('ws_TEST0001', 'unknown@co.com')).rejects.toThrow(CliError);
    await expect(resolveMemberByEmail('ws_TEST0001', 'unknown@co.com')).rejects.toThrow('member');
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
    const invite = await resolveInviteByIdOrEmail('ws_TEST0001', 'pending@co.com');
    expect(invite).toEqual(fakeMembersResponse.invites[0]);
  });

  it('finds invite by inv_ publicId (Phase 117 — not raw UUID)', async () => {
    const responseWithPublicIdInvite = {
      members: [],
      invites: [
        { id: 'inv_TESTxyz0', email: 'pending@co.com', role: 'admin', workspaceId: 'ws_TEST0001', invitedBy: 'usr_TEST001', createdAt: '2026-01-01' },
      ],
    };
    mockedApiClient.mockResolvedValue(responseWithPublicIdInvite);
    const { resolveInviteByIdOrEmail } = await import('../commands/workspace.js');
    const invite = await resolveInviteByIdOrEmail('ws_TEST0001', 'inv_TESTxyz0');
    expect(invite).toEqual(responseWithPublicIdInvite.invites[0]);
  });

  it('throws CliError when invite not found', async () => {
    mockedApiClient.mockResolvedValue(fakeMembersResponse);
    const { resolveInviteByIdOrEmail } = await import('../commands/workspace.js');
    const { CliError } = await import('../output/error.js');
    await expect(resolveInviteByIdOrEmail('ws_TEST0001', 'unknown@co.com')).rejects.toThrow(CliError);
    await expect(resolveInviteByIdOrEmail('ws_TEST0001', 'unknown@co.com')).rejects.toThrow('invite');
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
    fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001' }));

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

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/members');
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
      mockedApiClient.mockResolvedValue({ id: 'inv_TESTnew', email: 'new@co.com', role: 'member' });

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'invite', 'new@co.com'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/members', {
        method: 'POST',
        body: JSON.stringify({ email: 'new@co.com', role: 'member' }),
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Invited'));
    });

    it('sends POST with --role admin', async () => {
      mockedApiClient.mockResolvedValue({ id: 'inv_TESTnew', email: 'new@co.com', role: 'admin' });

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'invite', 'new@co.com', '--role', 'admin'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/members', {
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

    it('under --json emits a shaped DTO, never the raw invite row (no internal UUIDs)', async () => {
      // Backend returns the full Prisma row: internal UUID id, workspaceId,
      // invitedBy user UUID. The CLI must shape it, not spread it.
      mockedApiClient.mockResolvedValue({
        id: 'a79634d0-7d8b-435c-8d49-9e5a524645ae',
        email: 'new@co.com',
        role: 'member',
        workspaceId: 'b1234567-0000-0000-0000-000000000000',
        invitedBy: 'c9999999-0000-0000-0000-000000000000',
        status: 'invited',
      });
      mockedOutput.mockClear();

      const program = new Command();
      program.option('--json');
      registerWorkspaceCommand(program);
      await program.parseAsync(['workspace', 'members', 'invite', 'new@co.com', '--json'], { from: 'user' });

      expect(mockedOutput).toHaveBeenCalledWith(
        { email: 'new@co.com', role: 'member', status: 'invited' },
        expect.objectContaining({ human: false }),
      );
      const [payload] = mockedOutput.mock.calls.at(-1)!;
      expect(payload).not.toHaveProperty('id');
      expect(payload).not.toHaveProperty('workspaceId');
      expect(payload).not.toHaveProperty('invitedBy');
    });
  });

  describe('members remove', () => {
    it('without --yes prints dry-run and returns without process.exit', async () => {
      mockedApiClient.mockResolvedValue(fakeMembersResponse);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await program.parseAsync(['workspace', 'members', 'remove', 'member@co.com'], { from: 'user' });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Would remove'));
      // Return, not process.exit — so the normal flushAndExit path runs.
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('without --yes in --json mode emits a structured dryRun envelope via output() (no human text)', async () => {
      mockedApiClient.mockResolvedValue(fakeMembersResponse);
      mockedOutput.mockClear();

      const program = new Command();
      program.option('--json');
      registerWorkspaceCommand(program);

      await program.parseAsync(
        ['workspace', 'members', 'remove', 'member@co.com', '--json'],
        { from: 'user' },
      );
      // output() is the structured-JSON path (mocked in this suite); the human
      // "Would remove ..." console.log must NOT fire under --json.
      expect(mockedOutput).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, action: 'remove-member' }),
        expect.objectContaining({ human: false }),
      );
      expect(mockConsoleLog).not.toHaveBeenCalledWith(
        expect.stringContaining('Would remove'),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('with --yes resolves email and sends DELETE', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveMemberByEmail
        .mockResolvedValueOnce({ success: true }); // DELETE

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'remove', 'member@co.com', '--yes'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/members/mem_TEST002', {
        method: 'DELETE',
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Removed'));
    });
  });

  describe('members role', () => {
    it('sends PATCH with correct role', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveMemberByEmail
        .mockResolvedValueOnce({ id: 'mem_TEST002', role: 'admin' }); // PATCH

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'members', 'role', 'member@co.com', '--role', 'admin'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/members/mem_TEST002', {
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

    it('under --json emits a shaped DTO, never the raw member row (no internal UUIDs)', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveMemberByEmail
        .mockResolvedValueOnce({
          id: 'a79634d0-7d8b-435c-8d49-9e5a524645ae',
          userId: 'u1234567-0000-0000-0000-000000000000',
          workspaceId: 'b1234567-0000-0000-0000-000000000000',
          workosMembershipId: 'wm_internal',
          role: 'admin',
        }); // PATCH
      mockedOutput.mockClear();

      const program = new Command();
      program.option('--json');
      registerWorkspaceCommand(program);
      await program.parseAsync(['workspace', 'members', 'role', 'member@co.com', '--role', 'admin', '--json'], { from: 'user' });

      expect(mockedOutput).toHaveBeenCalledWith(
        { email: 'member@co.com', role: 'admin' },
        expect.objectContaining({ human: false }),
      );
      const [payload] = mockedOutput.mock.calls.at(-1)!;
      expect(payload).not.toHaveProperty('userId');
      expect(payload).not.toHaveProperty('workspaceId');
      expect(payload).not.toHaveProperty('workosMembershipId');
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
    fs.writeFileSync(configPath, JSON.stringify({ activeWorkspaceId: 'ws_TEST0001' }));

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/workspace.js');
    registerWorkspaceCommand = mod.registerWorkspaceCommand;
  });

  describe('invites cancel', () => {
    it('without --yes prints dry-run and returns without process.exit', async () => {
      mockedApiClient.mockResolvedValue(fakeMembersResponse);

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);

      await program.parseAsync(['workspace', 'invites', 'cancel', 'pending@co.com'], { from: 'user' });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Would cancel'));
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('with --yes and email resolves invite and sends DELETE', async () => {
      mockedApiClient
        .mockResolvedValueOnce(fakeMembersResponse) // resolveInviteByIdOrEmail
        .mockResolvedValueOnce({ success: true }); // DELETE

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'invites', 'cancel', 'pending@co.com', '--yes'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/invites/inv_TEST001', {
        method: 'DELETE',
      });
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
    });

    it('with --yes and inv_ publicId resolves invite by ID and sends DELETE', async () => {
      const responseWithPublicIdInvite = {
        members: [],
        invites: [
          { id: 'inv_TESTxyz0', email: 'pending@co.com', role: 'admin', workspaceId: 'ws_TEST0001', invitedBy: 'usr_TEST001', createdAt: '2026-01-01' },
        ],
      };
      mockedApiClient
        .mockResolvedValueOnce(responseWithPublicIdInvite) // resolveInviteByIdOrEmail
        .mockResolvedValueOnce({ success: true }); // DELETE

      const program = new Command();
      program.option('--human');
      registerWorkspaceCommand(program);
      await program.parseAsync(['--human', 'workspace', 'invites', 'cancel', 'inv_TESTxyz0', '--yes'], { from: 'user' });

      expect(mockedApiClient).toHaveBeenCalledWith('/workspaces/ws_TEST0001/invites/inv_TESTxyz0', {
        method: 'DELETE',
      });
    });
  });
});

describe('per-env active workspace (AIT-83)', () => {
  let dir: string;
  let origDir: string | undefined;
  let origEnv: string | undefined;

  beforeEach(async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hma-ws-perenv-'));
    origDir = process.env.HOOKMYAPP_CONFIG_DIR;
    origEnv = process.env.HOOKMYAPP_ENV;
    process.env.HOOKMYAPP_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (origDir === undefined) delete process.env.HOOKMYAPP_CONFIG_DIR;
    else process.env.HOOKMYAPP_CONFIG_DIR = origDir;
    if (origEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = origEnv;
  });

  it('a staging `workspace use` does not leak into local', async () => {
    const { readWorkspaceConfig, writeWorkspaceConfig } = await import('../commands/workspace.js');

    process.env.HOOKMYAPP_ENV = 'staging';
    writeWorkspaceConfig({ activeWorkspaceId: 'ws_STAGING1', activeWorkspaceSlug: 'Staging WS' });
    expect(readWorkspaceConfig().activeWorkspaceId).toBe('ws_STAGING1');

    process.env.HOOKMYAPP_ENV = 'local';
    // No local slot yet → falls back to the legacy mirror (last write wins)
    // only via top-level fields; write a local one and staging must survive.
    writeWorkspaceConfig({ activeWorkspaceId: 'ws_LOCAL001', activeWorkspaceSlug: 'Local WS' });
    expect(readWorkspaceConfig().activeWorkspaceId).toBe('ws_LOCAL001');

    process.env.HOOKMYAPP_ENV = 'staging';
    expect(readWorkspaceConfig().activeWorkspaceId).toBe('ws_STAGING1');
    expect(readWorkspaceConfig().activeWorkspaceSlug).toBe('Staging WS');
  });

  it('falls back to the legacy top-level fields when no per-env slot exists', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { readWorkspaceConfig } = await import('../commands/workspace.js');

    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ activeWorkspaceId: 'ws_LEGACY01', activeWorkspaceSlug: 'Legacy' }),
    );
    process.env.HOOKMYAPP_ENV = 'staging';
    expect(readWorkspaceConfig().activeWorkspaceId).toBe('ws_LEGACY01');
  });
});
