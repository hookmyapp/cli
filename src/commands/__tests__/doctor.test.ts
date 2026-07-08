import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../auth/store.js', () => ({ readCredentials: vi.fn(async () => null) }));
vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
import { readCredentials } from '../../auth/store.js';
import { apiClient } from '../../api/client.js';
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
