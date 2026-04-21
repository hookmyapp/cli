import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 126 — wizard sandbox sub-flow, post-bind-code rework.
//
// The wizard (runSandboxFlow in src/auth/login.ts) was wired against the
// legacy click-path `POST /sandbox/sessions`, which Phase 126 Plan 03 deleted
// from the backend. The rewrite delegates to the bind-code-driven
// runSandboxStart for the no-existing-session case and keeps the
// "listen on the session you already bound" shortcut for repeat logins.
//
// These tests assert:
//   1. 0 sessions → runSandboxStart is called (with listen:true for the
//      legacy "auto-listen after login" UX).
//   2. 1 session → direct listen, no prompt.
//   3. N sessions → picker (NO "+ Create new" sentinel any more; binding
//      is phone-initiated via an inbound WhatsApp message).
//   4. --phone with existing session → direct listen.
//   5. --phone with no match → ValidationError pointing the user at
//      `hookmyapp sandbox start` (NO POST to /sandbox/sessions).
//   6. No test case POSTs to `/sandbox/sessions` — that endpoint is gone.
//
// Guardrail (RESEARCH.md anti-pattern): the wizard must NOT spawn any
// subprocess. runSandboxStart imports are stubbed here so the real command
// body isn't invoked during the test.

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

const runSandboxStartMock = vi.fn();
vi.mock('../sandbox.js', () => ({
  registerSandboxCommand: vi.fn(),
  runSandboxStart: runSandboxStartMock,
  runSandboxSend: vi.fn(),
  runSandboxEnv: vi.fn(),
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
  runSandboxStartMock.mockReset();
  vi.resetModules();
  const mod = await import('../../auth/login.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runSandboxFlow = (mod as any).runSandboxFlow;
});

describe('wizard sandbox sub-flow — Phase 126 bind-code rework', () => {
  it('0 sessions → delegates to runSandboxStart with listen:true (no POST to /sandbox/sessions)', async () => {
    apiClientMock.mockResolvedValueOnce([]);
    await runSandboxFlow();
    expect(runSandboxStartMock).toHaveBeenCalledTimes(1);
    expect(runSandboxStartMock).toHaveBeenCalledWith(
      expect.objectContaining({ listen: true }),
    );
    // Guardrail: no POST to the deleted legacy endpoint.
    for (const call of apiClientMock.mock.calls) {
      const [path, init] = call;
      if (path === '/sandbox/sessions' && init?.method === 'POST') {
        throw new Error(
          'Regression: wizard POSTed to /sandbox/sessions which was deleted in Phase 126 Plan 03',
        );
      }
    }
  });

  it('1 session → direct listen (no input, no picker, no POST)', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TESTonly',
        phone: '15551112222',
        accessToken: 'abc12345',
        hmacSecret: 'HMAC_only',
        status: 'active',
      },
    ]);
    await runSandboxFlow();
    expect(inputMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(runSandboxStartMock).not.toHaveBeenCalled();
    expect(runSandboxListenFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ssn_TESTonly' }),
    );
  });

  it('N sessions → picker over existing sessions only (NO "+ Create new")', async () => {
    apiClientMock.mockResolvedValueOnce([
      { id: 'a', phone: '15551111111', status: 'active' },
      { id: 'b', phone: '15552222222', status: 'active' },
    ]);
    selectMock.mockResolvedValueOnce({
      id: 'a',
      phone: '15551111111',
      status: 'active',
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
    expect(choiceNames).not.toContain('+ Create new');
    expect(choiceNames).toContain('+15551111111');
    expect(choiceNames).toContain('+15552222222');
    expect(runSandboxListenFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
    );
    expect(runSandboxStartMock).not.toHaveBeenCalled();
  });

  it('--phone matches existing session → direct listen', async () => {
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
    expect(runSandboxStartMock).not.toHaveBeenCalled();
  });

  it('--phone with no matching session → ValidationError pointing at sandbox start (NO POST)', async () => {
    apiClientMock.mockResolvedValueOnce([]);
    await expect(
      runSandboxFlow({ phone: '+15557778888' }),
    ).rejects.toThrow(/sandbox start/);
    // Guardrail: assert no POST was attempted.
    for (const call of apiClientMock.mock.calls) {
      const [path, init] = call;
      if (path === '/sandbox/sessions' && init?.method === 'POST') {
        throw new Error(
          'Regression: wizard POSTed to /sandbox/sessions for --phone mismatch',
        );
      }
    }
    expect(runSandboxStartMock).not.toHaveBeenCalled();
  });

  it('wizard source does not reference the deleted POST /sandbox/sessions endpoint (grep regression guard)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../../auth/login.ts', import.meta.url),
      'utf8',
    );
    // The wizard must not issue POST /sandbox/sessions anywhere. Look for
    // the two-line pattern that would indicate a creation call:
    //   apiClient('/sandbox/sessions', { method: 'POST', ... })
    const combined = src.replace(/\s+/g, ' ');
    expect(combined).not.toMatch(
      /'\/sandbox\/sessions'[^)]*method:\s*'POST'/,
    );
    expect(combined).not.toMatch(
      /"\/sandbox\/sessions"[^)]*method:\s*"POST"/,
    );
  });
});
