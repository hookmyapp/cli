import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Wave 0 RED: the `sandbox send` subcommand does not exist yet in
// src/commands/sandbox.ts. Importing `runSandboxSend` fails RED.

const inputMock = vi.fn();
const selectMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: inputMock,
  select: selectMock,
  confirm: vi.fn(),
}));

const apiClientMock = vi.fn();
vi.mock('../../api/client.js', () => ({
  apiClient: apiClientMock,
  forceTokenRefresh: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runSandboxSend: any;

beforeEach(async () => {
  inputMock.mockReset();
  selectMock.mockReset();
  apiClientMock.mockReset();
  vi.resetModules();
  const mod = await import('../sandbox.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runSandboxSend = (mod as any).runSandboxSend;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedOneSession() {
  apiClientMock.mockResolvedValueOnce([
    {
      id: 'sess-1',
      phone: '15551234567',
      activationCode: 'ACT_xxx',
      hmacSecret: 'HMAC_yyy',
      status: 'active',
      workspaceId: 'w1',
    },
  ]);
}

describe('sandbox send — Wave 0 RED', () => {
  it('fully-flagged path: no prompts, correct POST to sandbox-proxy', async () => {
    seedOneSession();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: '15550000000', wa_id: '15550000000' }],
          messages: [{ id: 'wamid.ABC' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({
      phone: '+15551234567',
      to: '+15550000000',
      message: 'hello',
    });
    expect(inputMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://sandbox.hookmyapp.com/v22.0/15551234567/messages',
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe(
      'Bearer ACT_xxx',
    );
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15550000000',
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('partial flags: only --to given → prompts message, uses picker for phone', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'sess-1',
        phone: '15551234567',
        activationCode: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'w1',
      },
      {
        id: 'sess-2',
        phone: '15559999999',
        activationCode: 'ACT_two',
        hmacSecret: 'HMAC_two',
        status: 'active',
        workspaceId: 'w1',
      },
    ]);
    selectMock.mockResolvedValueOnce({
      id: 'sess-1',
      phone: '15551234567',
      activationCode: 'ACT_xxx',
    });
    inputMock.mockResolvedValueOnce('prompted message');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.ZZZ' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({ to: '+15550000000' });
    expect(selectMock).toHaveBeenCalled();
    expect(inputMock).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('success output (human): `✓ Message sent to +15550000000 (id: wamid.ABC)`', async () => {
    seedOneSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxSend({
      phone: '+15551234567',
      to: '+15550000000',
      message: 'hello',
    });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Message sent to +15550000000');
    expect(out).toContain('wamid.ABC');
  });

  it('template 403 from proxy → throws ApiError with body.error.message', async () => {
    seedOneSession();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: 'Template param mismatch',
            type: 'ForbiddenError',
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { ApiError } = await import('../../output/error.js');
    await expect(
      runSandboxSend({
        phone: '+15551234567',
        to: '+15550000000',
        message: '[[template:foo]]',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).rejects.toBeInstanceOf(ApiError as any);
  });

  it('strips leading + from --to before POSTing to Meta', async () => {
    seedOneSession();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.XYZ' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({
      phone: '+15551234567',
      to: '+15550000000',
      message: 'hi',
    });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body.to).toBe('15550000000');
    expect(body.to).not.toContain('+');
  });
});
