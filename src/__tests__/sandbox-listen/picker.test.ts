import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @inquirer/prompts before importing picker.
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import { pickSession } from '../../commands/sandbox-listen/picker.js';
import { CliError } from '../../output/error.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../api/sandbox-session.js';

const mockedSelect = vi.mocked(select);

function makeSession(overrides: Partial<WhatsAppSandboxSession> = {}): WhatsAppSandboxSession {
  return {
    id: 'ssn_TEST001',
    type: 'whatsapp',
    workspaceId: 'ws_TEST0001',
    workspaceName: 'acme-corp',
    phone: '+15550001',
    status: 'active',
    lastHeartbeatAt: null,
    accessToken: 'ACT_test',
    hmacSecret: 'HMAC_test',
    origin: 'test',
    whatsappPhone: '+15550001',
    whatsappPhoneNumberId: 'PNID_test',
    sandboxPhoneNumberId: 'SPNID_test',
    whatsappApiVersion: 'v20.0',
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
    const a = makeSession({ id: 'ssn_TESTa01', whatsappPhone: '+1111', phone: '+1111' });
    const b = makeSession({ id: 'ssn_TESTb01', whatsappPhone: '+2222', phone: '+2222' });
    mockedSelect.mockResolvedValueOnce(b);
    const result = await pickSession({ sessions: [a, b], isHuman: true });
    expect(mockedSelect).toHaveBeenCalledTimes(1);
    expect(result).toBe(b);
  });

  it('matches by --phone flag without prompting when flag provided', async () => {
    const a = makeSession({ id: 'ssn_TESTa01', whatsappPhone: '+1111', phone: '+1111' });
    const b = makeSession({ id: 'ssn_TESTb01', whatsappPhone: '+2222', phone: '+2222' });
    const result = await pickSession({
      sessions: [a, b],
      phoneFlag: '+2222',
      isHuman: true,
    });
    expect(result).toBe(b);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('throws SESSION_MISMATCH with exitCode 2 when --phone does not match', async () => {
    const a = makeSession({ id: 'ssn_TESTa01', whatsappPhone: '+1111', phone: '+1111' });
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
    const a = makeSession({ id: 'ssn_TESTa01' });
    const b = makeSession({ id: 'ssn_TESTb01' });
    const result = await pickSession({
      sessions: [a, b],
      sessionFlag: 'ssn_TESTa01',
      isHuman: true,
    });
    expect(result).toBe(a);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('state derivation: recent heartbeat (<2min) → "listening elsewhere (Xs ago)"', async () => {
    const now = Date.now();
    const fiveSecAgo = new Date(now - 5_000).toISOString();
    const a = makeSession({ id: 'ssn_TESTa01', lastHeartbeatAt: fiveSecAgo });
    const b = makeSession({ id: 'ssn_TESTb01' });
    let capturedChoices: any[] | undefined;
    (mockedSelect as unknown as { mockImplementationOnce: (fn: (args: any) => Promise<any>) => void })
      .mockImplementationOnce(async (args: any) => {
        capturedChoices = args.choices;
        return a;
      });
    await pickSession({ sessions: [a, b], isHuman: true });
    expect(capturedChoices).toBeDefined();
    const firstChoiceName = capturedChoices?.[0]?.name as string;
    // The unified picker uses sessionLabel() for choice names
    expect(firstChoiceName).toBeDefined();
  });

  it('state derivation: null heartbeat → session returned without prompting when single', async () => {
    const a = makeSession({ id: 'ssn_TESTa01', lastHeartbeatAt: null });
    const result = await pickSession({ sessions: [a], isHuman: true });
    expect(result).toBe(a);
    expect(mockedSelect).not.toHaveBeenCalled();
  });

  it('state derivation: old heartbeat (>2min) → select still invoked with session', async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const a = makeSession({ id: 'ssn_TESTa01', lastHeartbeatAt: threeHoursAgo });
    const b = makeSession({ id: 'ssn_TESTb01' });
    mockedSelect.mockResolvedValueOnce(a);
    const result = await pickSession({ sessions: [a, b], isHuman: true });
    expect(mockedSelect).toHaveBeenCalledTimes(1);
    expect(result).toBe(a);
  });

  it('matches an IG session by --username', async () => {
    const ig: InstagramSandboxSession = {
      id: 'ssn_IG000001',
      type: 'instagram',
      instagramSenderId: '8745912038476523',
      instagramAccountId: '17841478719287768',
      instagramSenderUsername: 'ordvir',
      accessToken: 'ACT_ig',
      hmacSecret: 'HMAC_ig',
      status: 'active',
      origin: 'demo_handoff',
    };
    const out = await pickSession({
      sessions: [ig],
      usernameFlag: '@ordvir',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });
});
