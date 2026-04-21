import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 0 RED: asserts the sandbox sub-flow branches referenced from the
// post-login wizard. runSandboxFlow isn't exported from src/auth/login.ts
// yet, so these tests fail RED on "not a function".

// Guardrail (RESEARCH.md anti-pattern): the wizard must NOT spawn any
// subprocess. This file deliberately avoids those imports — the grep
// acceptance-criterion in the plan enforces this absence.

const selectMock = vi.fn();
const inputMock = vi.fn();
const confirmMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  select: selectMock,
  input: inputMock,
  confirm: confirmMock,
}));

const apiClientMock = vi.fn();
vi.mock('../../api/client.js', () => ({
  apiClient: apiClientMock,
  forceTokenRefresh: vi.fn(),
}));

const runSandboxListenFlowMock = vi.fn();
vi.mock('../sandbox-listen/index.js', () => ({
  registerListenCommand: vi.fn(),
  runSandboxListenFlow: runSandboxListenFlowMock,
}));

vi.mock('../../commands/workspace.js', () => ({
  writeWorkspaceConfig: vi.fn(),
  readWorkspaceConfig: () => ({
    activeWorkspaceId: 'ws_TEST0001',
    activeWorkspaceSlug: 'acme-corp',
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runSandboxFlow: any;

beforeEach(async () => {
  selectMock.mockReset();
  inputMock.mockReset();
  confirmMock.mockReset();
  apiClientMock.mockReset();
  runSandboxListenFlowMock.mockReset();
  vi.resetModules();
  const mod = await import('../../auth/login.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runSandboxFlow = (mod as any).runSandboxFlow;
});

describe('wizard sandbox sub-flow — Wave 0 RED', () => {
  it('0 sessions → prompt phone → create + listen', async () => {
    // First apiClient call: list active sessions (empty).
    apiClientMock.mockResolvedValueOnce([]);
    inputMock.mockResolvedValueOnce('+15551234567');
    // Second apiClient call: POST create session → returns session object.
    apiClientMock.mockResolvedValueOnce({
      id: 'ssn_TESTnew',
      phone: '15551234567',
      accessToken: 'ACT_new',
      hmacSecret: 'HMAC_new',
      status: 'pending_activation',
    });
    await runSandboxFlow();
    expect(inputMock).toHaveBeenCalled();
    expect(apiClientMock).toHaveBeenNthCalledWith(
      2,
      '/sandbox/sessions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(runSandboxListenFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ssn_TESTnew' }),
    );
  });

  it('1 session → direct listen (no input, no picker)', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TESTonly',
        phone: '15551112222',
        accessToken: 'ACT_only',
        hmacSecret: 'HMAC_only',
        status: 'active',
      },
    ]);
    await runSandboxFlow();
    expect(inputMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(runSandboxListenFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ssn_TESTonly' }),
    );
  });

  it('N sessions → picker includes `+ Create new` option', async () => {
    apiClientMock.mockResolvedValueOnce([
      { id: 'a', phone: '15551111111', status: 'active' },
      { id: 'b', phone: '15552222222', status: 'active' },
    ]);
    // User picks create-new sentinel.
    selectMock.mockResolvedValueOnce('__CREATE_NEW__');
    inputMock.mockResolvedValueOnce('+15553333333');
    apiClientMock.mockResolvedValueOnce({
      id: 'ssn_TESTnew',
      phone: '15553333333',
      accessToken: 'ACT_new',
      hmacSecret: 'HMAC_new',
      status: 'pending_activation',
    });
    await runSandboxFlow();
    const pickerCall = selectMock.mock.calls[0][0];
    const choiceNames = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pickerCall.choices as any[]
    )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => String(c.name))
      .join(' | ');
    expect(choiceNames).toContain('+ Create new');
    expect(runSandboxListenFlowMock).toHaveBeenCalled();
  });

  it('--phone authoritative, matches existing → direct listen (no picker/prompt)', async () => {
    apiClientMock.mockResolvedValueOnce([
      { id: 'a', phone: '15551234567', status: 'active' },
      { id: 'b', phone: '15552222222', status: 'active' },
    ]);
    await runSandboxFlow({ phone: '+15551234567' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
    expect(runSandboxListenFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
    );
  });

  it('--phone mismatch → ConflictError from createSession surfaces (code PHONE_TAKEN_ANOTHER)', async () => {
    apiClientMock.mockResolvedValueOnce([]); // no sessions
    // createSession POST rejects with conflict
    const { ConflictError } = await import('../../output/error.js');
    apiClientMock.mockRejectedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (ConflictError as any)(
        'Phone taken by another workspace',
        'PHONE_TAKEN_ANOTHER',
      ),
    );
    await expect(runSandboxFlow({ phone: '+15557778888' })).rejects.toMatchObject(
      { code: 'PHONE_TAKEN_ANOTHER' },
    );
  });
});
