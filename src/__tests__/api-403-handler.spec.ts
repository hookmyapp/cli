import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthError, PermissionError, CliError } from '../output/error.js';

vi.mock('../auth/store.js', () => ({
  readCredentials: vi.fn().mockReturnValue({
    accessToken: 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64') + '.sig',
    refreshToken: 'r',
    expiresAt: Date.now() + 3_600_000,
  }),
  saveCredentials: vi.fn(),
}));

vi.mock('../commands/workspace.js', () => ({
  readWorkspaceConfig: vi.fn().mockReturnValue({ activeWorkspaceSlug: 'acme' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('apiClient permission handling (RBAC-UX-05/06/07)', () => {
  it('RBAC-UX-05: 403 response throws PermissionError with exitCode 3 and admin-required message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    const { apiClient } = await import('../api/client.js');
    await expect(apiClient('/workspaces')).rejects.toMatchObject({
      exitCode: 3,
      code: 'PERMISSION_DENIED',
    });
    await expect(apiClient('/workspaces')).rejects.toThrow(/workspace admin permission/);
    // Regression: must not claim a role we don't actually know.
    await expect(apiClient('/workspaces')).rejects.not.toThrow(/role:\s*member/);
  });

  it('RBAC-UX-06: 401 response throws AuthError with exitCode 4', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    const { apiClient } = await import('../api/client.js');
    await expect(apiClient('/workspaces')).rejects.toMatchObject({
      exitCode: 4,
      code: 'AUTH_REQUIRED',
    });
  });

  it('RBAC-UX-07: CliError subclasses carry exitCode; plain Error does not', () => {
    expect(new AuthError().exitCode).toBe(4);
    expect(new PermissionError('acme').exitCode).toBe(3);
    expect((new Error('boom') as unknown as CliError).exitCode).toBeUndefined();
  });
});
