import { describe, it, expect, vi } from 'vitest';

vi.mock('../../auth/store.js', () => ({
  readCredentials: vi.fn(async () => ({
    accessToken: 'login-token',
    refreshToken: 'refresh',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })),
  saveCredentials: vi.fn(async () => undefined),
}));

describe('apiRedirectLocation', () => {
  it('sends the login credential and workspace, returns the redirect target without following it', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://storage.example/signed?x=1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiRedirectLocation } = await import('../client.js');
    const loc = await apiRedirectLocation('/channels/ch_a/whatsapp/media/m1/download', { workspaceId: 'ws_1' });
    expect(loc).toBe('https://storage.example/signed?x=1');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer login-token');
    expect((init.headers as Record<string, string>)['X-Workspace-Id']).toBe('ws_1');
    vi.unstubAllGlobals();
  });
});
