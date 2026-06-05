import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the external surfaces the device-flow touches so the branch runs
// hermetically: open() (browserless), saveCredentials, posthog, and the
// wizard's apiClient (returns a single workspace so runWizard completes).
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

vi.mock('../store.js', () => ({
  saveCredentials: vi.fn(async () => undefined),
  peekIdentity: vi.fn(async () => null),
}));

vi.mock('../../observability/posthog.js', () => ({
  posthogAliasAndIdentify: vi.fn(async () => undefined),
}));

const apiClientMock = vi.fn(async () => [
  { id: 'ws_TEST0001', name: 'acme-corp', role: 'admin', workosOrganizationId: 'org_1' },
]);
vi.mock('../../api/client.js', () => ({
  apiClient: apiClientMock,
  forceTokenRefresh: vi.fn(),
  setWorkspaceContext: vi.fn(),
}));

vi.mock('../../commands/workspace.js', () => ({
  writeWorkspaceConfig: vi.fn(),
  readWorkspaceConfig: () => ({}),
}));

import { Command } from 'commander';
import { loginCommand } from '../login.js';

describe('login device-flow verification URL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClientMock.mockResolvedValue([
      { id: 'ws_TEST0001', name: 'acme-corp', role: 'admin', workosOrganizationId: 'org_1' },
    ]);
  });

  it('prints the verification URL alongside the user code', async () => {
    // First fetch = device authorize; second = token poll (success).
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          device_code: 'dev_123',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://auth.example.com/device',
          verification_uri_complete: 'https://auth.example.com/device?code=WXYZ-1234',
          interval: 0,
          expires_in: 300,
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r', user: { email: 'x@y.z' } }), { status: 200 }),
      );
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { writes.push(String(s)); return true; });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { writes.push(a.join(' ')); });

    const program = new Command();
    program.exitOverride();
    program.option('--json');
    loginCommand(program);
    await program.parseAsync(['node', 'hookmyapp', 'login', '--next', 'exit']);

    stdoutSpy.mockRestore();
    logSpy.mockRestore();
    void fetchMock;
    const out = writes.join('\n');
    expect(out).toContain('https://auth.example.com/device');
  });
});
