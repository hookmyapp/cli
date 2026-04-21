import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 126 Plan 06 — `hookmyapp sandbox start --listen` chain.
//
// When `--listen` is passed, after the bind code is consumed + the session
// detail is fetched, the command chains into `runSandboxListenFlow` IN-PROCESS
// (via function import — NEVER subprocess spawn). Mirrors the Phase 108
// CLI-108-02 post-login `runSandboxFlow` pattern.
//
// The chain must pass a Session object with id=publicId, phone, workspaceId —
// matching the sandbox-listen/picker.ts `Session` shape (not the looser
// SandboxSessionLite from auth/login).

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

describe('sandbox start --listen — chains into runSandboxListenFlow in-process', () => {
  it('invokes runSandboxListenFlow with a Session object after successful bind', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'lst88888',
      issuedAt: '2026-04-21T12:30:00.000Z',
    });
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'lst88888',
      issuedAt: '2026-04-21T12:30:00.000Z',
      consumedSessionId: 'ssn_LISTEN01',
    });
    mocks.apiClientMock.mockResolvedValueOnce({
      id: 'ssn_LISTEN01',
      publicId: 'ssn_LISTEN01',
      phone: '+15551234567',
      accessToken: 'lst88888',
      workspaceId: 'ws_TEST0001',
      status: 'active',
    });
    mocks.runSandboxListenFlowMock.mockResolvedValueOnce(undefined);

    const promise = runSandboxStart({ listen: true });
    await advancePollOnce();
    await promise;

    // Called exactly once — single chain, no double-invoke.
    expect(mocks.runSandboxListenFlowMock).toHaveBeenCalledTimes(1);

    // First arg: Session with id = publicId (ssn_...), phone, workspaceId.
    const [sessionArg, optsArg] = mocks.runSandboxListenFlowMock.mock.calls[0];
    expect(sessionArg).toEqual(
      expect.objectContaining({
        id: 'ssn_LISTEN01',
        phone: '+15551234567',
        workspaceId: 'ws_TEST0001',
      }),
    );
    // Second arg may be an empty opts object (or omitted) — matches the
    // runSandboxListenFlow(session, opts?) signature at sandbox-listen/index.ts:56.
    expect(optsArg === undefined || typeof optsArg === 'object').toBe(true);
  });

  it('does NOT invoke runSandboxListenFlow when --listen is omitted', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'nol55555',
      issuedAt: '2026-04-21T12:30:00.000Z',
    });
    mocks.getBindCodeMock.mockResolvedValueOnce({
      code: 'nol55555',
      issuedAt: '2026-04-21T12:30:00.000Z',
      consumedSessionId: 'ssn_NOLISTEN',
    });
    mocks.apiClientMock.mockResolvedValueOnce({
      id: 'ssn_NOLISTEN',
      publicId: 'ssn_NOLISTEN',
      phone: '+15551234567',
      accessToken: 'nol55555',
      workspaceId: 'ws_TEST0001',
      status: 'active',
    });

    const promise = runSandboxStart({});
    await advancePollOnce();
    await promise;

    expect(mocks.runSandboxListenFlowMock).not.toHaveBeenCalled();
  });
});
