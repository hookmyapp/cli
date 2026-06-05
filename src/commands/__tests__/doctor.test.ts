import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../auth/store.js', () => ({ readCredentials: vi.fn(async () => null) }));
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
