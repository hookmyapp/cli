import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock api client
vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
  forceTokenRefresh: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));

// Mock output
vi.mock('../output/format.js', () => ({
  output: vi.fn(),
}));

// Mock open
vi.mock('open', () => ({
  default: vi.fn(),
}));

// Mock workspace config
vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceId: 'ws_TEST0010' }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// Mock _helpers — its real `getDefaultWorkspaceId` dynamic-imports
// `../index.js` (the CLI root with commander wiring), which interacts badly
// with `vi.useFakeTimers()` in the polling tests below. The stub returns the
// same workspace id the existing tests assume.
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0010'),
  runWithInstrumentation: vi.fn(async (_cmd: string, _sub: string | null, fn: () => Promise<unknown>) => fn()),
}));

// Mock store
vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockResolvedValue({ accessToken: 'test-token', refreshToken: 'test-refresh' }),
  saveCredentials: vi.fn().mockResolvedValue(undefined),
}));

const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import open from 'open';

const mockedApiClient = vi.mocked(apiClient);
const mockedOutput = vi.mocked(output);
const mockedOpen = vi.mocked(open);

const fakeChannels = [
  {
    id: 'ch_TEST0001',
    workspaceId: 'ws_TEST0010',
    metaWabaId: 'waba-1',
    wabaName: 'Test WABA',
    displayPhoneNumber: '+1 234 567 890',
    phoneVerifiedName: 'Test Verified',
    connectionType: 'cloud_api',
    metaConnected: true,
    forwardingEnabled: true,
    qualityRating: 'GREEN',
    webhookUrl: 'https://example.com/webhook',
    verifyToken: 'tok-123',
  },
  {
    id: 'ch_TEST0002',
    workspaceId: 'ws_TEST0020',
    metaWabaId: 'waba-2',
    wabaName: 'Another WABA',
    displayPhoneNumber: '+1 987 654 321',
    phoneVerifiedName: null,
    connectionType: 'coexistence',
    metaConnected: true,
    forwardingEnabled: true,
    qualityRating: null,
    webhookUrl: null,
    verifyToken: null,
  },
];

const fakeDetailResponse = {
  id: 'ch_TEST0002',
  workspaceId: 'ws_TEST0020',
  metaWabaId: 'waba-2',
  wabaName: 'Another WABA',
  displayPhoneNumber: '+1 987 654 321',
  phoneVerifiedName: null,
  connectionType: 'coexistence',
  metaConnected: true,
  forwardingEnabled: true,
  qualityRating: null,
  accessToken: 'real-token-value',
  businessName: 'Acme Corp',
  metaBusinessId: 'biz-123',
  phoneNumberId: 'phone-2',
  webhookUrl: null,
  verifyToken: null,
};

describe('channels commands', () => {
  let registerChannelsCommand: typeof import('../commands/channels.js').registerChannelsCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockedOpen.mockReset();
    mockConsoleError.mockClear();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/channels.js');
    registerChannelsCommand = mod.registerChannelsCommand;
  });

  it('listChannels calls apiClient /meta/channels with workspaceId and passes display fields to output', async () => {
    mockedApiClient.mockResolvedValue(fakeChannels);

    const program = new Command();
    registerChannelsCommand(program);
    await program.parseAsync(['channels', 'list'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    // Verify output was called with filtered + display-picked channels
    expect(mockedOutput).toHaveBeenCalledTimes(1);
    const outputArgs = mockedOutput.mock.calls[0][0] as Record<string, unknown>[];
    // Both channels are metaConnected=true, so both should be in output
    expect(outputArgs).toHaveLength(2);
    // pickDisplayFields removes id, workspaceId, and qualityRating (re-adds only for non-coexistence with value)
    expect(outputArgs[0]).not.toHaveProperty('id');
    expect(outputArgs[0]).not.toHaveProperty('workspaceId');
    expect(outputArgs[0]).toHaveProperty('metaWabaId', 'waba-1');
    expect(outputArgs[0]).toHaveProperty('qualityRating', 'GREEN'); // cloud_api with value
    expect(outputArgs[1]).not.toHaveProperty('qualityRating'); // coexistence, null quality
  });

  it('showChannel calls list to resolve, then calls detail endpoint, outputs without routing keys', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels) // list call for resolveChannel (with workspaceId)
      .mockResolvedValueOnce(fakeDetailResponse); // detail endpoint call

    const program = new Command();
    registerChannelsCommand(program);
    await program.parseAsync(['channels', 'show', 'waba-2'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_TEST0002');
    // pickDisplayFields removes id, workspaceId, and qualityRating (coexistence + null = not re-added)
    expect(mockedOutput).toHaveBeenCalledTimes(1);
    const outputArgs = mockedOutput.mock.calls[0][0];
    expect(outputArgs).not.toHaveProperty('id');
    expect(outputArgs).not.toHaveProperty('workspaceId');
    expect(outputArgs).not.toHaveProperty('qualityRating');
    expect(outputArgs).toHaveProperty('metaWabaId', 'waba-2');
    expect(outputArgs).toHaveProperty('accessToken', 'real-token-value');
  });

  it('throws CliError when channel not found', async () => {
    mockedApiClient.mockResolvedValue(fakeChannels);

    const program = new Command();
    registerChannelsCommand(program);

    await expect(
      program.parseAsync(['channels', 'show', '999'], { from: 'user' }),
    ).rejects.toThrow('channel not found');
  });

  it('disconnectChannel calls apiClient with POST and workspaceId from channel lookup', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels) // channel lookup (with workspaceId)
      .mockResolvedValueOnce({ success: true }); // disconnect call

    const program = new Command();
    registerChannelsCommand(program);
    await program.parseAsync(['channels', 'disconnect', 'waba-1'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_TEST0001/disconnect', {
      method: 'POST',
      workspaceId: 'ws_TEST0010',
    });
  });

  it('connectChannel calls forceTokenRefresh and opens server-minted Embedded Signup URL', async () => {
    // Phase plan 12 — `runChannelsConnect` now POSTs `/meta/oauth/start`
    // (server mints state + PKCE) instead of building the Facebook URL inline
    // with `state=cli:<jwt>`. The first apiClient call is the OAuth-start POST;
    // the second is the channel snapshot.
    const startResponse = {
      state: 'srv-state-abc',
      redirectUrl: 'https://www.facebook.com/v21.0/dialog/oauth?client_id=123&state=srv-state-abc',
      codeChallenge: 'pkce-challenge',
    };
    mockedApiClient
      .mockResolvedValueOnce(startResponse) // POST /meta/oauth/start
      .mockResolvedValueOnce([]); // initial snapshot /meta/channels
    // Suppress console.log
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    registerChannelsCommand(program);
    // Don't await -- it will poll for 15 min. Just verify the initial flow.
    const p = program.parseAsync(['channels', 'connect'], { from: 'user' });

    // Wait a tick for the async calls to resolve
    await new Promise((r) => setTimeout(r, 50));

    const { forceTokenRefresh } = await import('../api/client.js');
    expect(forceTokenRefresh).toHaveBeenCalled();
    // Asserts the new server-side flow: POST /meta/oauth/start with workspace
    // header + redirectPath body, and opens the server-returned redirectUrl
    // verbatim (no client-side URL construction, no JWT in the URL).
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/oauth/start', {
      method: 'POST',
      workspaceId: 'ws_TEST0010',
      body: JSON.stringify({ redirectPath: '/cli/callback' }),
    });
    expect(mockedOpen).toHaveBeenCalledWith(startResponse.redirectUrl);

    // Clean up: restore console.log to stop polling side effects
    vi.mocked(console.log).mockRestore();
  });

  it('enableChannel calls apiClient with POST and workspaceId', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels)
      .mockResolvedValueOnce({ enabled: true });

    const program = new Command();
    registerChannelsCommand(program);
    await program.parseAsync(['channels', 'enable', 'waba-2'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_TEST0002/enable', {
      method: 'POST',
      workspaceId: 'ws_TEST0020',
    });
  });

  it('disableChannel calls apiClient with POST and workspaceId', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels)
      .mockResolvedValueOnce({ disabled: true });

    const program = new Command();
    registerChannelsCommand(program);
    await program.parseAsync(['channels', 'disable', 'waba-2'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_TEST0002/disable', {
      method: 'POST',
      workspaceId: 'ws_TEST0020',
    });
  });

  // Nyquist Dimension 3 — boundary assertion: old `accounts` command must NOT exist.
  // Proves the rename is absolute — not just that `channels` works, but that `accounts`
  // is genuinely gone. If someone ever re-registers an `accounts` alias, this test
  // catches it.
  it('boundary: old `accounts` command is unknown (Nyquist Dim-3)', async () => {
    const program = new Command();
    // Disable commander's default process.exit on unknown command so we can assert.
    program.exitOverride();
    registerChannelsCommand(program);

    await expect(
      program.parseAsync(['accounts', 'list'], { from: 'user' }),
    ).rejects.toThrow(/unknown command|accounts/i);
  });
});

describe('health command', () => {
  let registerHealthCommand: typeof import('../commands/health.js').registerHealthCommand;
  let Command: typeof import('commander').Command;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOutput.mockReset();
    mockConsoleError.mockClear();

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/health.js');
    registerHealthCommand = mod.registerHealthCommand;
  });

  it('health command calls refresh with POST and workspaceId', async () => {
    mockedApiClient
      .mockResolvedValueOnce(fakeChannels) // channel lookup
      .mockResolvedValueOnce({ metaConnected: true, forwardingEnabled: true, wabaName: 'Test' }); // health result

    const program = new Command();
    registerHealthCommand(program);
    await program.parseAsync(['health', 'waba-1'], { from: 'user' });

    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels', { workspaceId: 'ws_TEST0010' });
    expect(mockedApiClient).toHaveBeenCalledWith('/meta/channels/ch_TEST0001/refresh', {
      method: 'POST',
      workspaceId: 'ws_TEST0010',
    });
    expect(mockedOutput).toHaveBeenCalledWith(
      { metaConnected: true, forwardingEnabled: true, wabaName: 'Test' },
      expect.objectContaining({}),
    );
  });
});

describe('channels connect — npx prefix roll-out (cliCommandPrefix)', () => {
  let Command: typeof import('commander').Command;
  let runChannelsConnect: typeof import('../commands/channels.js').runChannelsConnect;
  let mockConsoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    mockedApiClient.mockReset();
    mockedOpen.mockReset();
    mockConsoleError.mockClear();
    vi.stubEnv('npm_command', 'exec');
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const commander = await import('commander');
    Command = commander.Command;
    const mod = await import('../commands/channels.js');
    runChannelsConnect = mod.runChannelsConnect;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    mockConsoleLog.mockRestore();
  });

  it('connect flow after channel detected without webhook prints "npx hookmyapp webhook set" + "npx hookmyapp env" hints', async () => {
    // Speed up the 5s poll interval by stubbing setTimeout.
    vi.useFakeTimers();

    const newChannel = {
      id: 'new-ch',
      metaWabaId: 'waba-new',
      displayPhoneNumber: '+1 555 0000',
      phoneVerifiedName: 'New Co',
      webhookUrl: null,
    };

    // apiClient call order: POST /meta/oauth/start, snapshot /meta/channels (empty),
    // then inside poll — nothing (uses fetch directly).
    mockedApiClient
      .mockResolvedValueOnce({
        state: 'srv-state-1',
        redirectUrl: 'https://www.facebook.com/v21.0/dialog/oauth?state=srv-state-1',
        codeChallenge: 'pkce-1',
      }) // POST /meta/oauth/start
      .mockResolvedValueOnce([]); // initial snapshot

    // Stub global fetch: first polled /meta/channels returns [newChannel].
    const origFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [newChannel],
    } as any));
    globalThis.fetch = fetchMock as any;

    try {
      const p = runChannelsConnect();
      // Advance fake timers past the 5s poll interval
      await vi.advanceTimersByTimeAsync(5000);
      // Let any microtasks run
      await vi.runAllTimersAsync();
      await p;

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('npx hookmyapp webhook set waba-new');
      expect(logged).toContain('npx hookmyapp env waba-new');
      // No bare-hookmyapp hint at line-start
      expect(logged).not.toMatch(/^\s{2}hookmyapp (webhook|env) /m);
    } finally {
      globalThis.fetch = origFetch;
    }
  }, 10000);

  it('connect flow after channel detected WITH webhook prints "npx hookmyapp env" hint', async () => {
    vi.useFakeTimers();

    const newChannel = {
      id: 'new-ch-2',
      metaWabaId: 'waba-hook',
      displayPhoneNumber: '+1 555 1111',
      phoneVerifiedName: 'HookCo',
      webhookUrl: 'https://example.com/hook',
    };

    mockedApiClient
      .mockResolvedValueOnce({
        state: 'srv-state-2',
        redirectUrl: 'https://www.facebook.com/v21.0/dialog/oauth?state=srv-state-2',
        codeChallenge: 'pkce-2',
      }) // POST /meta/oauth/start
      .mockResolvedValueOnce([]); // initial snapshot

    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [newChannel],
    } as any)) as any;

    try {
      const p = runChannelsConnect();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.runAllTimersAsync();
      await p;

      const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('npx hookmyapp env waba-hook');
      expect(logged).not.toContain('hookmyapp webhook set'); // webhook already set
    } finally {
      globalThis.fetch = origFetch;
    }
  }, 10000);
});
