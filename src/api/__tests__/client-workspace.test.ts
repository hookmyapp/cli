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

describe('apiClient FormData bodies (AIT-713)', () => {
  it('sends no JSON content-type for FormData, so fetch writes the multipart boundary, and uses the transfer timeout', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');

    await apiClient('/channels/ch_1/whatsapp/uploads', { method: 'POST', body: form });

    const init = fetchSpy.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(init.body).toBe(form);
    expect(timeout).toHaveBeenCalledWith(600_000);
  });

  it('keeps the JSON content-type for a string body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await apiClient('/x', { method: 'POST', body: '{}' });
    expect((fetchSpy.mock.calls[0][1]!.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});

