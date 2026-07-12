import { describe, it, expect, vi } from 'vitest';
import { pickSession } from '../picker.js';
import { ValidationError, CliError } from '../../../output/error.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  senderInstagramId: '8745912038476523',
  accountInstagramId: '17841478719287768',
  senderInstagramUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

const igNoUsername: InstagramSandboxSession = {
  ...ig,
  id: 'ssn_IG000002',
  senderInstagramUsername: null,
};

describe('pickSession — flag conflicts (D3, error E4/E5)', () => {
  it('throws ValidationError when both --phone and --username are provided', async () => {
    await expect(
      pickSession({
        sessions: [wa, ig],
        phoneFlag: '+15551234567',
        usernameFlag: '@ordvir',
        isHuman: true,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when both --phone and --session are provided', async () => {
    await expect(
      pickSession({
        sessions: [wa],
        phoneFlag: '+15551234567',
        sessionFlag: 'ssn_WA000001',
        isHuman: true,
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });
});

describe('pickSession — exact match by flag', () => {
  it('--phone matches a WA session', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      phoneFlag: '+15551234567',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_WA000001');
  });

  it('--phone strips leading + for normalization', async () => {
    const out = await pickSession({
      sessions: [wa],
      phoneFlag: '15551234567',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_WA000001');
  });

  it('--username matches an IG session and strips leading @', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      usernameFlag: 'ordvir',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });

  it('--username @<handle> works with the leading @', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      usernameFlag: '@ordvir',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });

  it('--session matches by publicId', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      sessionFlag: 'ssn_IG000001',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });
});

describe('pickSession — mismatch paths (E6, E7)', () => {
  it('throws SESSION_MISMATCH exit 2 on --phone with no match', async () => {
    try {
      await pickSession({
        sessions: [wa, ig],
        phoneFlag: '+99999999999',
        isHuman: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('throws SESSION_MISMATCH on --session with no match', async () => {
    try {
      await pickSession({
        sessions: [wa, ig],
        sessionFlag: 'ssn_MISSING1',
        isHuman: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('emits null-backfill-aware message when --username has no match because all IG candidates have null username', async () => {
    try {
      await pickSession({
        sessions: [wa, igNoUsername],
        usernameFlag: '@ordvir',
        isHuman: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as Error).message).toMatch(/still resolving from Meta/);
      expect((err as Error).message).toMatch(/--session/);
    }
  });
});

describe('pickSession — zero and one session', () => {
  it('throws NO_ACTIVE_SESSIONS exit 2 as a ValidationError (non-5xx status) when sessions array is empty', async () => {
    try {
      await pickSession({ sessions: [], isHuman: true });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('NO_ACTIVE_SESSIONS');
      expect((err as CliError).exitCode).toBe(2);
      // AIT-159: a user-state precondition must not resolve to a 5xx status in
      // the --json envelope. ValidationError → httpStatus 400.
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as CliError).statusCode).toBe(400);
    }
  });

  it('silently auto-picks the single session when no flag is given and alwaysShowPicker is false', async () => {
    const out = await pickSession({
      sessions: [wa],
      isHuman: true,
    });
    expect(out.id).toBe('ssn_WA000001');
  });
});

describe('pickSession — non-TTY mode', () => {
  it('throws SESSION_MISMATCH exit 2 when multiple sessions exist + no flag + not human', async () => {
    try {
      await pickSession({
        sessions: [wa, ig],
        isHuman: false,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as CliError).exitCode).toBe(2);
      expect((err as Error).message).toMatch(/Multiple active sessions/);
    }
  });
});

describe('pickSession — identifierArg positional (D3)', () => {
  it('+phone positional resolves to WA session', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: '+15551234567',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_WA000001');
  });

  it('bare phone positional resolves to WA session', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: '15551234567',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_WA000001');
  });

  it('@handle positional resolves to IG session', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: '@ordvir',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_IG000001');
  });

  it('ssn_X positional resolves to exact session by id', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: 'ssn_IG000001',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_IG000001');
  });

  it('ch_X positional → ValidationError (wrong family — channel id used on sandbox)', async () => {
    await expect(
      pickSession({
        sessions: [wa, ig],
        identifierArg: 'ch_abcdefgh',
        isHuman: false,
      }),
    ).rejects.toThrow(/channel publicId.*sandbox commands take ssn_X/);
  });

  it('positional + flag → CONFLICTING_SELECTORS', async () => {
    await expect(
      pickSession({
        sessions: [wa],
        identifierArg: '+15551234567',
        phoneFlag: '+15551234567',
        isHuman: false,
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });

});

describe('pickSession — alwaysShowPicker (sandbox send)', () => {
  it('shows interactive picker even with a single session when alwaysShowPicker is true', async () => {
    // The top-of-file static import has already cached pickSession.js. To
    // swap @inquirer/prompts for the duration of this one test, reset the
    // module registry, install the doMock, and dynamically re-import.
    const selectMock = vi.fn().mockResolvedValue(wa);
    vi.resetModules();
    vi.doMock('@inquirer/prompts', () => ({ select: selectMock }));
    const { pickSession: piPicker } = await import('../picker.js');

    const out = await piPicker({
      sessions: [wa],
      isHuman: true,
      alwaysShowPicker: true,
    });
    expect(out.id).toBe('ssn_WA000001');
    expect(selectMock).toHaveBeenCalled();
    vi.doUnmock('@inquirer/prompts');
    vi.resetModules();
  });
});
