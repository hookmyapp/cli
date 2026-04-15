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

// Seed an active workspace so `_helpers.getDefaultWorkspaceId` resolves from
// config instead of making its own `apiClient('/workspaces')` call.
vi.mock('../workspace.js', () => ({
  readWorkspaceConfig: () => ({
    activeWorkspaceId: 'w1',
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
      id: 'sess-1',
      phone: '15551234567',
      activationCode: 'ACT_xxx',
      hmacSecret: 'HMAC_yyy',
      status: 'active',
      workspaceId: 'w1',
      // Phase 260415-jmg: backend now exposes the shared sandbox WABA
      // phone-number-id on every session, and `sandbox send` MUST route
      // through it (not the customer phone).
      sandboxPhoneNumberId: '1080996501762047',
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
      'https://sandbox.hookmyapp.com/v22.0/1080996501762047/messages',
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
        sandboxPhoneNumberId: '1080996501762047',
      },
      {
        id: 'sess-2',
        phone: '15559999999',
        activationCode: 'ACT_two',
        hmacSecret: 'HMAC_two',
        status: 'active',
        workspaceId: 'w1',
        sandboxPhoneNumberId: '1080996501762047',
      },
    ]);
    selectMock.mockResolvedValueOnce({
      id: 'sess-1',
      phone: '15551234567',
      activationCode: 'ACT_xxx',
      sandboxPhoneNumberId: '1080996501762047',
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

  // ---- Phase 260415-jmg new acceptance tests ----

  it('S3: 1 active session, no --phone → picker IS shown (no silent auto-pick)', async () => {
    seedOneSession();
    selectMock.mockResolvedValueOnce({
      id: 'sess-1',
      phone: '15551234567',
      activationCode: 'ACT_xxx',
      sandboxPhoneNumberId: '1080996501762047',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: 'wamid.S3' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await runSandboxSend({
      to: '+15550000000',
      message: 'hi',
    });
    expect(selectMock).toHaveBeenCalled();
  });

  it('S4: 0 active sessions → ValidationError mentioning `sandbox start`', async () => {
    apiClientMock.mockResolvedValueOnce([]);
    await expect(
      runSandboxSend({ to: '+15550000000', message: 'hi' }),
    ).rejects.toThrow(/sandbox start/);
  });

  it('S5: --phone +99999 with no matching session → ValidationError naming +99999 and listing available phones', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'sess-1',
        phone: '15551234567',
        activationCode: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'w1',
        sandboxPhoneNumberId: '1080996501762047',
      },
    ]);
    await expect(
      runSandboxSend({
        phone: '+99999',
        to: '+15550000000',
        message: 'hi',
      }),
    ).rejects.toThrow(/\+99999/);
    // Re-run to also assert it lists available phones (rejects.toThrow only
    // accepts one matcher per call).
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'sess-1',
        phone: '15551234567',
        activationCode: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'w1',
        sandboxPhoneNumberId: '1080996501762047',
      },
    ]);
    await expect(
      runSandboxSend({
        phone: '+99999',
        to: '+15550000000',
        message: 'hi',
      }),
    ).rejects.toThrow(/Available:.*\+15551234567/);
  });

  it('S6: 403 SESSION_WINDOW_CLOSED → throws SessionWindowError with body.message verbatim', async () => {
    seedOneSession();
    const friendlyMessage =
      'Cannot send to +15550000000 — this number has not sent an inbound message in the last 24 hours. WhatsApp requires the recipient to message first before you can reply.';
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
        to: '+15550000000',
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
        to: '+15550000000',
        message: 'hi',
      });
      const [url] = fetchSpy.mock.calls[0];
      expect(String(url)).toBe(
        'https://override.example/v22.0/1080996501762047/messages',
      );
    } finally {
      if (orig === undefined) delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
      else process.env.HOOKMYAPP_SANDBOX_PROXY_URL = orig;
    }
  });
});
