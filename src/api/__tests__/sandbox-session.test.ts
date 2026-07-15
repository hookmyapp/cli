import { describe, it, expect } from 'vitest';
import {
  parseSandboxSession,
  parseSandboxSessions,
  assertNever,
  INSTAGRAM_GRAPH_VERSION,
  type WhatsAppSandboxSession,
  type InstagramSandboxSession,
} from '../sandbox-session.js';
import { UnexpectedError } from '../../output/error.js';

const baseShared = {
  id: 'ssn_TEST0001',
  accessToken: 'ACT_xxx',
  hmacSecret: 'HMAC_yyy',
  verifyToken: 'VT_test',
  status: 'active',
  origin: 'manual',
};

const validWa = {
  ...baseShared,
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  // optional fields tolerated:
  phone: '15551234567',
  workspaceId: 'ws_TEST0001',
  workspaceName: 'Test workspace',
};

const validIg = {
  ...baseShared,
  type: 'instagram',
  senderInstagramId: '8745912038476523',
  accountInstagramId: '17841478719287768',
  senderInstagramUsername: 'ordvir',
};

describe('parseSandboxSession', () => {
  it('returns a typed WhatsApp variant for a valid WA wire row', () => {
    const parsed = parseSandboxSession(validWa);
    expect(parsed.type).toBe('whatsapp');
    const wa = parsed as WhatsAppSandboxSession;
    expect(wa.whatsappPhone).toBe('15551234567');
    expect(wa.whatsappPhoneNumberId).toBe('1080996501762047');
    expect(wa.sandboxPhoneNumberId).toBe('1080996501762047');
    expect(wa.whatsappApiVersion).toBe('v24.0');
  });

  it('returns a typed Instagram variant for a valid IG wire row', () => {
    const parsed = parseSandboxSession(validIg);
    expect(parsed.type).toBe('instagram');
    const ig = parsed as InstagramSandboxSession;
    expect(ig.senderInstagramId).toBe('8745912038476523');
    expect(ig.accountInstagramId).toBe('17841478719287768');
    expect(ig.senderInstagramUsername).toBe('ordvir');
  });

  it('tolerates null senderInstagramUsername (backend backfills async)', () => {
    const parsed = parseSandboxSession({
      ...validIg,
      senderInstagramUsername: null,
    });
    expect((parsed as InstagramSandboxSession).senderInstagramUsername).toBeNull();
  });

  it('When IG session uses senderInstagramId/accountInstagramId/senderInstagramUsername (Phase A renames), then parser accepts and old names are absent', () => {
    const dto = {
      id: 'ssn_TEST0001',
      type: 'instagram',
      accessToken: 'ACT_xxx',
      hmacSecret: 'HMAC_yyy',
      verifyToken: 'VT_test',
      status: 'active',
      origin: 'manual',
      senderInstagramId: '12345',
      accountInstagramId: '67890',
      senderInstagramUsername: 'audit',
      // lastHeartbeatAt: ABSENT (dropped from wire)
      // instagramSenderUsername: ABSENT (old name)
      // instagramSenderId: ABSENT (old name)
      // instagramAccountId: ABSENT (old name)
    };
    const parsed = parseSandboxSession(dto) as InstagramSandboxSession;
    expect(parsed.senderInstagramId).toBe('12345');
    expect(parsed.accountInstagramId).toBe('67890');
    expect(parsed.senderInstagramUsername).toBe('audit');
    expect(parsed).not.toHaveProperty('lastHeartbeatAt');
    expect(parsed).not.toHaveProperty('instagramSenderUsername');
    expect(parsed).not.toHaveProperty('instagramSenderId');
    expect(parsed).not.toHaveProperty('instagramAccountId');
  });

  it('does NOT require workspaceId — backend strips it from list responses', () => {
    const { workspaceId: _wsId, ...withoutWorkspace } = validWa;
    expect(() => parseSandboxSession(withoutWorkspace)).not.toThrow();
  });

  it('does NOT require sandboxPhoneNumberId or whatsappApiVersion on IG sessions', () => {
    expect(() => parseSandboxSession(validIg)).not.toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => parseSandboxSession({ ...baseShared, type: 'messenger' })).toThrow(
      UnexpectedError,
    );
  });

  it('rejects missing type', () => {
    const { ...withoutType } = baseShared;
    expect(() => parseSandboxSession(withoutType as object)).toThrow(UnexpectedError);
  });

  it('rejects WA session missing whatsappPhone', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, whatsappPhone: null }),
    ).toThrow(/whatsappPhone/);
  });

  it('rejects WA session missing sandboxPhoneNumberId', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, sandboxPhoneNumberId: null }),
    ).toThrow(/sandboxPhoneNumberId/);
  });

  it('rejects WA session missing whatsappApiVersion', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, whatsappApiVersion: '' }),
    ).toThrow(/whatsappApiVersion/);
  });

  it('rejects IG session missing senderInstagramId', () => {
    expect(() =>
      parseSandboxSession({ ...validIg, senderInstagramId: '' }),
    ).toThrow(/senderInstagramId/);
  });

  it('rejects IG session missing accountInstagramId', () => {
    expect(() =>
      parseSandboxSession({ ...validIg, accountInstagramId: null }),
    ).toThrow(/accountInstagramId/);
  });

  it('rejects shared base field missing accessToken', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, accessToken: '' }),
    ).toThrow(/accessToken/);
  });

  it('rejects shared base field missing id', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, id: '' }),
    ).toThrow(/id missing/);
  });

  it('rejects shared base field missing origin', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, origin: '' }),
    ).toThrow(/origin/);
  });

  it('rejects status that is not in the allowed closed union', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, status: 'pending_activision' }),
    ).toThrow(/status must be one of/);
  });

  it('includes the session id in the error message', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, accessToken: '' }),
    ).toThrow(/ssn_TEST0001/);
  });

  it('rejects non-object input', () => {
    expect(() => parseSandboxSession(null)).toThrow(UnexpectedError);
    expect(() => parseSandboxSession('not an object')).toThrow(UnexpectedError);
  });
});

describe('parseSandboxSessions', () => {
  it('parses an array of mixed valid sessions', () => {
    const out = parseSandboxSessions([validWa, validIg]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('whatsapp');
    expect(out[1].type).toBe('instagram');
  });

  it('rejects a non-array input', () => {
    expect(() => parseSandboxSessions(validWa)).toThrow(UnexpectedError);
  });

  it('propagates the inner parser error with the offending session id', () => {
    expect(() =>
      parseSandboxSessions([
        validWa,
        { ...validIg, id: 'ssn_BADIG01', senderInstagramId: '' },
      ]),
    ).toThrow(/ssn_BADIG01/);
    expect(() =>
      parseSandboxSessions([
        validWa,
        { ...validIg, id: 'ssn_BADIG01', senderInstagramId: '' },
      ]),
    ).toThrow(/senderInstagramId/);
  });
});

describe('assertNever', () => {
  it('throws UnexpectedError with the context string', () => {
    // Construct a value that bypasses TS exhaustiveness so we can exercise the runtime path.
    const v = 'unexpected' as never;
    expect(() => assertNever(v, 'test context')).toThrow(/test context/);
  });
});

describe('INSTAGRAM_GRAPH_VERSION', () => {
  it('is the current pinned IG Graph version', () => {
    expect(INSTAGRAM_GRAPH_VERSION).toBe('v25.0');
  });
});
