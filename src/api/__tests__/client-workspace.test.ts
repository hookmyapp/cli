import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiClient, setWorkspaceContext } from '../client.js';

// Mock store so apiClient doesn't hit the real config dir during import.
// Mirrors the pattern in client.test.ts — `expiresAt` is far enough in the
// future that the apiClient's refresh-on-expiry branch is never triggered.
vi.mock('../../auth/store.js', () => ({
  readCredentials: vi.fn(() =>
    Promise.resolve({
      accessToken: 'test-token',
      refreshToken: 'refresh',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  ),
  saveCredentials: vi.fn(() => Promise.resolve(undefined)),
}));

afterEach(() => {
  setWorkspaceContext({ workspaceId: null });
  vi.restoreAllMocks();
});

describe('apiClient X-Workspace-Id injection', () => {
  it('injects X-Workspace-Id from global workspace context when no explicit override', async () => {
    setWorkspaceContext({ workspaceId: 'ws_globalcontextxyz' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await apiClient('/meta/channels');
    const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Workspace-Id']).toBe('ws_globalcontextxyz');
  });

  it('explicit options.workspaceId wins over global context', async () => {
    setWorkspaceContext({ workspaceId: 'ws_globalcontextxyz' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await apiClient('/meta/channels', { workspaceId: 'ws_explicitoverride' });
    const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Workspace-Id']).toBe('ws_explicitoverride');
  });

  it('does NOT inject for /workspaces endpoint (chicken-and-egg)', async () => {
    setWorkspaceContext({ workspaceId: 'ws_globalcontextxyz' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    await apiClient('/workspaces');
    const headers = (fetchSpy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Workspace-Id']).toBeUndefined();
  });
});
