import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 126 Plan 06 — `hookmyapp sandbox start` rework.
//
// New flow (replaces the pre-126 activation-code click path):
//   1. Fetch user's available bind code via GET /sandbox/bind-code.
//   2. Print bind code + (TTY-gated) terminal QR of the wa.me URL + raw URL fallback.
//   3. Poll GET /sandbox/bind-code every 2s until `consumedSessionId` populates.
//   4. Fetch the consumed session detail via GET /sandbox/sessions/:id and
//      announce `✓ Session created. Phone: {phone}. Token: {accessToken}`.
//   5. Exit 0; on AuthError exit 4; on ConflictError exit 6 (via mapApiError).
//
// These tests drive the bind-code fetch, the QR render, the poll loop, the
// consumed-session fetch, and the error paths. The --listen in-process chain
// is covered in sibling sandbox-start-listen.test.ts.

const mocks = vi.hoisted(() => ({
  getBindCodeMock: vi.fn(),
  apiClientMock: vi.fn(),
  qrcodeGenerateMock: vi.fn(),
  oraInstance: {
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
    stop: vi.fn(),
  },
  oraFactoryMock: vi.fn(),
  runSandboxListenFlowMock: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({
  apiClient: mocks.apiClientMock,
  getBindCode: mocks.getBindCodeMock,
  forceTokenRefresh: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  input: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: mocks.qrcodeGenerateMock },
  generate: mocks.qrcodeGenerateMock,
}));

vi.mock('ora', () => ({
  default: mocks.oraFactoryMock,
}));

vi.mock('../sandbox-listen/index.js', () => ({
  registerListenCommand: vi.fn(),
  runSandboxListenFlow: mocks.runSandboxListenFlowMock,
}));

vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

vi.mock('../workspace.js', () => ({
  readWorkspaceConfig: () => ({
    activeWorkspaceId: 'ws_TEST0001',
    activeWorkspaceSlug: 'acme-corp',
  }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runSandboxStart: any;

// Helper — drives the poll loop forward by flushing the promise queue + the
// 2000ms setTimeout setTimeout that sleep() waits on. Each invocation consumes
// one iteration of the poll loop.
async function advancePollOnce() {
  await vi.advanceTimersByTimeAsync(2000);
}

beforeEach(async () => {
  mocks.getBindCodeMock.mockReset();
  mocks.apiClientMock.mockReset();
  mocks.qrcodeGenerateMock.mockReset();
  mocks.oraInstance.start.mockReset();
  mocks.oraInstance.succeed.mockReset();
  mocks.oraInstance.fail.mockReset();
  mocks.oraInstance.warn.mockReset();
  mocks.oraInstance.stop.mockReset();
  mocks.oraFactoryMock.mockReset();
  mocks.oraFactoryMock.mockReturnValue(mocks.oraInstance);
  mocks.runSandboxListenFlowMock.mockReset();
  vi.resetModules();
  const mod = await import('../sandbox.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runSandboxStart = (mod as any).runSandboxStart;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('sandbox start — Phase 126 bind-code flow', () => {
  it('prints bind code + QR + raw wa.me URL + polls then announces success', async () => {
    vi.useFakeTimers();
    const isTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Initial fetch: unconsumed bind code.
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'abc23456',
      issuedAt: '2026-04-21T12:30:00.000Z',
    });
    // First poll: still unconsumed.
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'abc23456',
      issuedAt: '2026-04-21T12:30:00.000Z',
    });
    // Second poll: consumed.
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'abc23456',
      issuedAt: '2026-04-21T12:30:00.000Z',
      consumedSessionId: 'ssn_TESTSES',
    });
    // getSandboxSession detail fetch returns the new session.
    mocks.apiClientMock.mockResolvedValueOnce({
      id: 'ssn_TESTSES',
      publicId: 'ssn_TESTSES',
      phone: '+15551234567',
      accessToken: 'abc23456',
      workspaceId: 'ws_TEST0001',
      status: 'active',
    });

    const promise = runSandboxStart({});
    // Drive two poll iterations.
    await advancePollOnce();
    await advancePollOnce();
    await promise;

    // Bind code printed.
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('abc23456');
    // Raw wa.me URL printed as text fallback.
    expect(out).toContain('https://wa.me/17372370900?text=abc23456');
    // QR rendered via qrcode-terminal.
    expect(mocks.qrcodeGenerateMock).toHaveBeenCalledWith(
      'https://wa.me/17372370900?text=abc23456',
      expect.objectContaining({ small: true }),
    );
    // Success spinner line carries phone + accessToken.
    expect(mocks.oraInstance.succeed).toHaveBeenCalledWith(
      expect.stringContaining('Session created'),
    );
    expect(mocks.oraInstance.succeed).toHaveBeenCalledWith(
      expect.stringContaining('+15551234567'),
    );
    expect(mocks.oraInstance.succeed).toHaveBeenCalledWith(
      expect.stringContaining('abc23456'),
    );

    if (isTty) Object.defineProperty(process.stdout, 'isTTY', isTty);
  });

  it('skips QR when stdout is not a TTY (pipe fallback)', async () => {
    vi.useFakeTimers();
    const isTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'xyz77777',
      issuedAt: '2026-04-21T12:30:00.000Z',
    });
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'xyz77777',
      issuedAt: '2026-04-21T12:30:00.000Z',
      consumedSessionId: 'ssn_PIPE0001',
    });
    mocks.apiClientMock.mockResolvedValueOnce({
      id: 'ssn_PIPE0001',
      publicId: 'ssn_PIPE0001',
      phone: '+15551112222',
      accessToken: 'xyz77777',
      workspaceId: 'ws_TEST0001',
      status: 'active',
    });

    const promise = runSandboxStart({});
    await advancePollOnce();
    await promise;

    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('xyz77777');
    // QR must NOT render when non-TTY.
    expect(mocks.qrcodeGenerateMock).not.toHaveBeenCalled();

    if (isTty) Object.defineProperty(process.stdout, 'isTTY', isTty);
  });

  it('propagates AuthError from bind-code fetch (exit 4 via mapApiError)', async () => {
    vi.useFakeTimers();
    const { AuthError } = await import('../../output/error.js');
    mocks.getBindCodeMock.mockRejectedValueOnce(new AuthError('Not logged in.'));

    await expect(runSandboxStart({})).rejects.toBeInstanceOf(AuthError);
  });

  it('propagates ConflictError from poll (exit 6 via mapApiError)', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    const { ConflictError } = await import('../../output/error.js');

    // Initial fetch succeeds.
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'con22222',
      issuedAt: '2026-04-21T12:30:00.000Z',
    });
    // Poll raises conflict (phone already bound elsewhere).
    mocks.getBindCodeMock.mockRejectedValueOnce(
      new ConflictError(
        'Phone already bound to another workspace',
        'PHONE_ALREADY_BOUND',
      ),
    );

    const promise = runSandboxStart({});
    const assertion = expect(promise).rejects.toBeInstanceOf(ConflictError);
    await advancePollOnce();
    await assertion;
  });
});
