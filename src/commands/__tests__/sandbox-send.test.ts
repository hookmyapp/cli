import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `sandbox send` policy: the recipient is ALWAYS the session's own phone.
// No `--to` flag, no "To:" prompt. Sandbox cannot message any other number.
// Server-side enforced in sandbox-proxy too (SANDBOX_RECIPIENT_MISMATCH 403).

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

vi.mock('../workspace.js', () => ({
  readWorkspaceConfig: () => ({
    activeWorkspaceId: 'ws_TEST0001',
    activeWorkspaceSlug: 'acme-corp',
  }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
  resolveWorkspace: vi.fn(),
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
      id: 'ssn_TEST001',
      phone: '15551234567',
      accessToken: 'ACT_xxx',
      hmacSecret: 'HMAC_yyy',
      status: 'active',
      workspaceId: 'ws_TEST0001',
      sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
    },
  ]);
}

describe('sandbox send', () => {
  it('fully-flagged path: no prompts, POSTs with recipient = session.phone', async () => {
    seedOneSession();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: '15551234567', wa_id: '15551234567' }],
          messages: [{ id: 'wamid.ABC' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({
      phone: '+15551234567',
      message: 'hello',
    });
    expect(inputMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://sandbox.hookmyapp.com/v24.0/1080996501762047/messages',
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe(
      'Bearer ACT_xxx',
    );
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('no flags, multi-session: picker selects session, prompt only for message', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TEST001',
        phone: '15551234567',
        accessToken: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'ws_TEST0001',
        sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
      },
      {
        id: 'sess-2',
        phone: '15559999999',
        accessToken: 'ACT_two',
        hmacSecret: 'HMAC_two',
        status: 'active',
        workspaceId: 'ws_TEST0001',
        sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
      },
    ]);
    selectMock.mockResolvedValueOnce({
      id: 'ssn_TEST001',
      phone: '15551234567',
      accessToken: 'ACT_xxx',
      sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
    });
    inputMock.mockResolvedValueOnce('prompted message');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.ZZZ' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({});
    expect(selectMock).toHaveBeenCalled();
    expect(inputMock).toHaveBeenCalledTimes(1); // message only, no "To:" prompt
    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? '{}'));
    expect(body.to).toBe('15551234567');
  });

  it('success output: prints recipient = session.phone (with leading +)', async () => {
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
      message: 'hello',
    });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Message sent to +15551234567');
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
        message: '[[template:foo]]',
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).rejects.toBeInstanceOf(ApiError as any);
  });

  it('strips leading + from session.phone before POSTing (idempotent normalization)', async () => {
    // Defensive: some backends might return phone with +, some without.
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TEST001',
        phone: '+15551234567', // with leading +
        accessToken: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'ws_TEST0001',
        sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
      },
    ]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.XYZ' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({
      phone: '+15551234567',
      message: 'hi',
    });
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? '{}'));
    expect(body.to).toBe('15551234567');
    expect(body.to).not.toContain('+');
  });

  it('S3: 1 active session, no --phone → picker IS shown (no silent auto-pick)', async () => {
    seedOneSession();
    selectMock.mockResolvedValueOnce({
      id: 'ssn_TEST001',
      phone: '15551234567',
      accessToken: 'ACT_xxx',
      sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.S3' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({
      message: 'hi',
    });
    expect(selectMock).toHaveBeenCalled();
  });

  it('S4: 0 active sessions → ValidationError mentioning `sandbox start`', async () => {
    apiClientMock.mockResolvedValueOnce([]);
    await expect(
      runSandboxSend({ message: 'hi' }),
    ).rejects.toThrow(/sandbox start/);
  });

  it('S5: --phone +99999 with no matching session → ValidationError naming +99999 and listing available phones', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TEST001',
        phone: '15551234567',
        accessToken: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'ws_TEST0001',
        sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
      },
    ]);
    await expect(
      runSandboxSend({
        phone: '+99999',
        message: 'hi',
      }),
    ).rejects.toThrow(/\+99999/);
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TEST001',
        phone: '15551234567',
        accessToken: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'ws_TEST0001',
        sandboxPhoneNumberId: '1080996501762047',
        whatsappApiVersion: 'v24.0',
      },
    ]);
    await expect(
      runSandboxSend({
        phone: '+99999',
        message: 'hi',
      }),
    ).rejects.toThrow(/Available:.*\+15551234567/);
  });

  it('S6: 403 SESSION_WINDOW_CLOSED → throws SessionWindowError with body.message verbatim', async () => {
    seedOneSession();
    const friendlyMessage =
      'Cannot send to +15551234567 — this number has not sent an inbound message in the last 24 hours. WhatsApp requires the recipient to message first before you can reply.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'SESSION_WINDOW_CLOSED',
          message: friendlyMessage,
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { SessionWindowError } = await import('../../output/error.js');
    let caught: unknown;
    try {
      await runSandboxSend({
        phone: '+15551234567',
        message: 'hi',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionWindowError as any);
    expect((caught as Error).message).toBe(friendlyMessage);
  });

  it('S7: HOOKMYAPP_SANDBOX_PROXY_URL=https://override.example → URL prefix uses the override', async () => {
    const orig = process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://override.example';
    try {
      seedOneSession();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ messages: [{ id: 'wamid.S7' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      await runSandboxSend({
        phone: '+15551234567',
        message: 'hi',
      });
      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe(
        'https://override.example/v24.0/1080996501762047/messages',
      );
    } finally {
      if (orig === undefined) delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
      else process.env.HOOKMYAPP_SANDBOX_PROXY_URL = orig;
    }
  });
});
