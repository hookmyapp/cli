import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../auth/store.js', () => ({ readCredentials: vi.fn(async () => null) }));
vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../workspace.js', () => ({ readWorkspaceConfig: vi.fn(() => ({})) }));
import { readCredentials } from '../../auth/store.js';
import { apiClient } from '../../api/client.js';
import { readWorkspaceConfig } from '../workspace.js';
import { AuthError, NetworkError } from '../../output/error.js';
import { collectDoctorReport } from '../doctor.js';

describe('doctor', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reports not-logged-in without throwing, and not-logged-in is NOT a hard failure', async () => {
    const report = await collectDoctorReport({ checkNetwork: false, checkTools: false });
    expect(report.loggedIn).toBe(false);
    expect(report.checks.find((c) => c.id === 'node')).toBeDefined();
    expect(report.checks.find((c) => c.id === 'default-channel')).toBeDefined();
    expect(report.ok).toBe(true); // auth is informational, not a prereq gate
  });
  it('flags an old node version as a hard failure (report.ok === false)', async () => {
    const report = await collectDoctorReport({ checkNetwork: false, checkTools: false, nodeVersionOverride: 'v18.20.0' });
    expect(report.checks.find((c) => c.id === 'node')!.ok).toBe(false);
    expect(report.ok).toBe(false); // drives the command's non-zero exit
  });
});

describe('doctor — auth probe uses the real authenticated request path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Health check fetch — reachable.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    vi.mocked(readCredentials).mockResolvedValue({
      accessToken: 'expired-but-refreshable',
      refreshToken: 'rt',
      expiresAt: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it('passes when apiClient succeeds (token refresh happens inside apiClient)', async () => {
    vi.mocked(apiClient).mockResolvedValue([]);

    const report = await collectDoctorReport({ checkTools: false });

    expect(apiClient).toHaveBeenCalledWith('/workspaces');
    expect(report.loggedIn).toBe(true);
    expect(report.checks.find((c) => c.id === 'auth')!.detail).toBe(
      'credentials valid for this env',
    );
  });

  it('fails auth when apiClient throws AuthError (genuinely invalid credentials)', async () => {
    vi.mocked(apiClient).mockRejectedValue(new AuthError());

    const report = await collectDoctorReport({ checkTools: false });

    expect(report.loggedIn).toBe(false);
    expect(report.checks.find((c) => c.id === 'auth')!.detail).toContain(
      'rejected by this env',
    );
    expect(report.ok).toBe(true); // auth stays informational, never a hard gate
  });

  it('keeps the presence-based verdict on a network flake', async () => {
    vi.mocked(apiClient).mockRejectedValue(new NetworkError());

    const report = await collectDoctorReport({ checkTools: false });

    expect(report.loggedIn).toBe(true);
    expect(report.checks.find((c) => c.id === 'auth')!.detail).toBe('credentials present');
  });
});

describe('doctor — active workspace is validated against the backend (AIT-51)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
    vi.mocked(readCredentials).mockResolvedValue({
      accessToken: 't',
      refreshToken: 'rt',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(readWorkspaceConfig).mockReturnValue({
      activeWorkspaceId: 'ws_stale123',
      activeWorkspaceSlug: 'My Workspace',
    });
  });

  it('flags a persisted workspace missing from the backend list as stale', async () => {
    vi.mocked(apiClient).mockResolvedValue([{ id: 'ws_other456' }]);

    const report = await collectDoctorReport({ checkTools: false });

    const ws = report.checks.find((c) => c.id === 'workspace')!;
    expect(ws.ok).toBe(false);
    expect(ws.detail).toContain('workspace use');
    expect(report.ok).toBe(true); // informational, never a hard gate
  });

  it('passes when the persisted workspace exists on the backend', async () => {
    vi.mocked(apiClient).mockResolvedValue([{ id: 'ws_stale123' }]);

    const report = await collectDoctorReport({ checkTools: false });

    const ws = report.checks.find((c) => c.id === 'workspace')!;
    expect(ws.ok).toBe(true);
    expect(ws.detail).toBe('My Workspace');
  });

  it('keeps the cache-based verdict when the workspaces fetch fails', async () => {
    vi.mocked(apiClient).mockRejectedValue(new NetworkError());

    const report = await collectDoctorReport({ checkTools: false });

    const ws = report.checks.find((c) => c.id === 'workspace')!;
    expect(ws.ok).toBe(true);
    expect(ws.detail).toBe('My Workspace');
  });
});
