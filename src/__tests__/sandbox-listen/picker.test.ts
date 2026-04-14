import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @inquirer/prompts before importing picker.
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import { pickSession } from '../../commands/sandbox-listen/picker.js';
import { CliError } from '../../output/error.js';

const mockedSelect = vi.mocked(select);

function makeSession(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    workspaceName: 'acme-corp',
    phone: '+15550001',
    status: 'active',
    lastHeartbeatAt: null,
    ...overrides,
  };
}

describe('pickSession', () => {
  beforeEach(() => {
    mockedSelect.mockReset();
  });

  it('throws CliError NO_ACTIVE_SESSIONS with exitCode 2 when 0 sessions', async () => {
    let caught: CliError | undefined;
    try {
      await pickSession({ sessions: [], isHuman: true });
    } catch (e) {
      caught = e as CliError;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught?.code).toBe('NO_ACTIVE_SESSIONS');
    expect(caught?.exitCode).toBe(2);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('returns the only session silently when exactly 1 session', async () => {
    const s = makeSession();
    const result = await pickSession({ sessions: [s], isHuman: true });
    expect(result).toBe(s);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('invokes interactive select when 2+ sessions, no flag, isHuman=true', async () => {
    const a = makeSession({ id: 'sess-a', phone: '+1111' });
    const b = makeSession({ id: 'sess-b', phone: '+2222' });
    mockedSelect.mockResolvedValueOnce(b);
    const result = await pickSession({ sessions: [a, b], isHuman: true });
    expect(mockedSelect).toHaveBeenCalledTimes(1);
    expect(result).toBe(b);
  });

  it('matches by --phone flag without prompting when flag provided', async () => {
    const a = makeSession({ id: 'sess-a', phone: '+1111' });
    const b = makeSession({ id: 'sess-b', phone: '+2222' });
    const result = await pickSession({
      sessions: [a, b],
      phoneFlag: '+2222',
      isHuman: true,
    });
    expect(result).toBe(b);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('throws SESSION_MISMATCH with exitCode 2 when --phone does not match', async () => {
    const a = makeSession({ id: 'sess-a', phone: '+1111' });
    let caught: CliError | undefined;
    try {
      await pickSession({ sessions: [a], phoneFlag: '+9999', isHuman: true });
    } catch (e) {
      caught = e as CliError;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught?.code).toBe('SESSION_MISMATCH');
    expect(caught?.exitCode).toBe(2);
  });

  it('matches by --session flag without prompting', async () => {
    const a = makeSession({ id: 'sess-a' });
    const b = makeSession({ id: 'sess-b' });
    const result = await pickSession({
      sessions: [a, b],
      sessionFlag: 'sess-a',
      isHuman: true,
    });
    expect(result).toBe(a);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('state derivation: recent heartbeat (<2min) → "listening elsewhere (Xs ago)"', async () => {
    const now = Date.now();
    const fiveSecAgo = new Date(now - 5_000).toISOString();
    const a = makeSession({ id: 'sess-a', lastHeartbeatAt: fiveSecAgo });
    const b = makeSession({ id: 'sess-b' });
    let capturedChoices: any[] | undefined;
    mockedSelect.mockImplementationOnce(async (args: any) => {
      capturedChoices = args.choices;
      return a;
    });
    await pickSession({ sessions: [a, b], isHuman: true });
    expect(capturedChoices).toBeDefined();
    const firstChoiceName = capturedChoices?.[0]?.name as string;
    expect(firstChoiceName).toMatch(/listening elsewhere \(\d+s ago\)/);
  });

  it('state derivation: null heartbeat → "idle"', async () => {
    const a = makeSession({ id: 'sess-a', lastHeartbeatAt: null });
    const b = makeSession({ id: 'sess-b', lastHeartbeatAt: null });
    let capturedChoices: any[] | undefined;
    mockedSelect.mockImplementationOnce(async (args: any) => {
      capturedChoices = args.choices;
      return a;
    });
    await pickSession({ sessions: [a, b], isHuman: true });
    const firstName = capturedChoices?.[0]?.name as string;
    expect(firstName).toContain('idle');
    expect(firstName).not.toContain('last tunnel');
    expect(firstName).not.toContain('listening elsewhere');
  });

  it('state derivation: old heartbeat (>2min) → "idle (last tunnel Xh ago)" or Xm ago', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const a = makeSession({ id: 'sess-a', lastHeartbeatAt: threeHoursAgo });
    const b = makeSession({ id: 'sess-b' });
    let capturedChoices: any[] | undefined;
    mockedSelect.mockImplementationOnce(async (args: any) => {
      capturedChoices = args.choices;
      return a;
    });
    await pickSession({ sessions: [a, b], isHuman: true });
    const firstName = capturedChoices?.[0]?.name as string;
    expect(firstName).toMatch(/idle \(last tunnel \dh ago\)/);
  });
});
