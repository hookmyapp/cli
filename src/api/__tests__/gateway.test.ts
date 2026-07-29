import { describe, it, expect, vi, beforeEach } from 'vitest';

// Backend token endpoint now returns BOTH the token and the version-bearing baseUrl.
vi.mock('../client.js', () => ({
  apiClient: vi.fn(async () => ({ token: 'hmat_live_TESTTOKEN', baseUrl: 'https://gateway.example.com/meta/v22.0' })),
  isNetworkFailure: vi.fn(() => false),
}));
vi.mock('../../config/env-profiles.js', () => ({
  getGatewayBaseOverride: vi.fn(() => undefined), // no override → backend baseUrl wins
}));

import { gatewayRequest, substitutePath } from '../gateway.js';
import { ConflictError, exitCodeFor } from '../../output/error.js';

const waChannel = {
  id: 'ch_abc12345', type: 'whatsapp', workspaceId: 'ws_T0000001',
  whatsappPhoneNumberId: '979105081963262', metaWabaId: '1248091060795230',
  metaResourceId: '979105081963262',
} as any;

describe('substitutePath', () => {
  it('fills {phone_number_id} and {waba_id} from the channel (version-less paths)', () => {
    expect(substitutePath('/{waba_id}/message_templates', waChannel))
      .toBe('/1248091060795230/message_templates');
  });
  it('throws when a placeholder cannot be satisfied', () => {
    const ig = { ...waChannel, type: 'instagram', metaWabaId: null } as any;
    expect(() => substitutePath('/{waba_id}/x', ig)).toThrow(/waba_id/);
  });
});

describe('substitutePath — two numbers on one WABA (D7 passthrough)', () => {
  const numberOne = {
    id: 'ch_PNUM01', type: 'whatsapp', workspaceId: 'ws_T0000001',
    whatsappPhoneNumberId: 'pn_AAA', metaWabaId: 'SHARED_WABA_77', metaResourceId: 'SHARED_WABA_77',
  } as any;
  const numberTwo = { ...numberOne, id: 'ch_PNUM02', whatsappPhoneNumberId: 'pn_BBB' } as any;

  it('resolves {waba_id} identically for both numbers', () => {
    expect(substitutePath('/{waba_id}/message_templates', numberOne))
      .toBe(substitutePath('/{waba_id}/message_templates', numberTwo));
    expect(substitutePath('/{waba_id}/message_templates', numberOne))
      .toBe('/SHARED_WABA_77/message_templates');
  });

  it('resolves {phone_number_id} distinctly per number', () => {
    expect(substitutePath('/{phone_number_id}/messages', numberOne))
      .not.toBe(substitutePath('/{phone_number_id}/messages', numberTwo));
    expect(substitutePath('/{phone_number_id}/messages', numberOne)).toBe('/pn_AAA/messages');
    expect(substitutePath('/{phone_number_id}/messages', numberTwo)).toBe('/pn_BBB/messages');
  });
});

describe('gatewayRequest', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('joins backend baseUrl (with version) + path, sends the hmat_ bearer, returns JSON on 2xx', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const out = await gatewayRequest({ channel: waChannel, method: 'POST', path: '/{phone_number_id}/messages', body: { type: 'text' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example.com/meta/v22.0/979105081963262/messages');
    expect((init!.headers as Record<string,string>).Authorization).toBe('Bearer hmat_live_TESTTOKEN');
    expect(out).toEqual({ messages: [{ id: 'wamid.X' }] });
  });

  it('maps a Meta 4xx to ApiError carrying the Meta error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid parameter', code: 100 } }), { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    await expect(gatewayRequest({ channel: waChannel, method: 'POST', path: '/{phone_number_id}/messages', body: {} }))
      .rejects.toThrow(/Invalid parameter/);
  });

  it('explains a Meta account restriction instead of blaming the request body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2494160 } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    const err = await gatewayRequest({ channel: waChannel, method: 'POST', path: '/{waba_id}/message_templates', body: {} })
      .then(() => null, (e: unknown) => e);

    // Exit 6 is the conflict tier, NOT ValidationError's 2 — exit 2 tells a
    // script its input was wrong, the misdiagnosis this mapping exists to
    // prevent. Scripts should branch on the code, not the exit tier.
    // exitCodeFor() is asserted because that, not `.exitCode`, is what index.ts
    // actually exits with.
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({ code: 'META_ACCOUNT_RESTRICTED', statusCode: 409 });
    expect(exitCodeFor(err)).toBe(6);
    expect((err as ConflictError).userMessage).toMatch(/Business Support Home/);
  });

  it('still explains the restriction when Meta wraps it in a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 2494160 } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );

    const err = await gatewayRequest({ channel: waChannel, method: 'POST', path: '/{waba_id}/message_templates', body: {} })
      .then(() => null, (e: unknown) => e);

    expect(err).toMatchObject({ code: 'META_ACCOUNT_RESTRICTED' });
  });

  it('ignores a subcode that only exists on the object prototype', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 'constructor' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    const err = await gatewayRequest({ channel: waChannel, method: 'POST', path: '/{waba_id}/message_templates', body: {} })
      .then(() => null, (e: unknown) => e);

    expect(err).toMatchObject({ code: 'META_REJECTED' });
  });
});
