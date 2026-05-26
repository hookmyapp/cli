import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers the post-login wizard contract:
// - Single/multi/zero workspace resolution
// - Non-interactive "Next steps" block after workspace resolution
// - --next / --phone / --json escape hatches for scripts & integration tests

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
  setWorkspaceContext: vi.fn(),
}));

// Stateful so runSandboxFlow's readWorkspaceConfig reflects what runWizard wrote.
let workspaceConfigState: { activeWorkspaceId?: string; activeWorkspaceSlug?: string } =
  {};
const writeWorkspaceConfigMock = vi.fn(
  (cfg: { activeWorkspaceId?: string; activeWorkspaceSlug?: string }) => {
    workspaceConfigState = { ...workspaceConfigState, ...cfg };
  },
);
vi.mock('../../commands/workspace.js', () => ({
  writeWorkspaceConfig: writeWorkspaceConfigMock,
  readWorkspaceConfig: () => workspaceConfigState,
}));

const runSandboxListenFlowMock = vi.fn();
vi.mock('../../commands/sandbox-listen/index.js', () => ({
  runSandboxListenFlow: runSandboxListenFlowMock,
  registerListenCommand: vi.fn(),
}));

const runSandboxStartMock = vi.fn();
vi.mock('../../commands/sandbox/start.js', () => ({
  runSandboxStart: runSandboxStartMock,
}));

const runChannelsConnectMock = vi.fn();
vi.mock('../../commands/channels.js', () => ({
  runChannelsConnect: runChannelsConnectMock,
  registerChannelsCommand: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runWizard: any;

beforeEach(async () => {
  selectMock.mockReset();
  inputMock.mockReset();
  confirmMock.mockReset();
  apiClientMock.mockReset();
  writeWorkspaceConfigMock.mockClear();
  runSandboxListenFlowMock.mockReset();
  runSandboxStartMock.mockReset();
  runChannelsConnectMock.mockReset();
  workspaceConfigState = {};
  vi.resetModules();
  const mod = await import('../login.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runWizard = (mod as any).runWizard;
});

describe('post-login wizard', () => {
  it('single workspace, no --next → auto-selects workspace and exits without Next steps block', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ws_TEST0001',
        name: 'acme-corp',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard();
    // Single workspace auto-selected silently; no next-action picker.
    expect(selectMock).toHaveBeenCalledTimes(0);
    expect(writeWorkspaceConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkspaceId: 'ws_TEST0001',
        activeWorkspaceSlug: 'acme-corp',
      }),
    );
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('Next steps');
    expect(runSandboxListenFlowMock).not.toHaveBeenCalled();
    expect(runChannelsConnectMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('multi workspace → picker shows names, not UUIDs; no next-action picker', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ws_TESTw001',
        name: 'acme-corp',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
      {
        id: 'ws_TESTw002',
        name: 'beta-workspace',
        role: 'member',
        workosOrganizationId: 'org_2',
      },
    ]);
    selectMock.mockResolvedValueOnce({
      id: 'ws_TESTw001',
      name: 'acme-corp',
      workosOrganizationId: 'org_1',
    }); // workspace picker only
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard();
    // Only ONE select call: the workspace picker. No next-action prompt.
    expect(selectMock).toHaveBeenCalledTimes(1);
    const pickerCall = selectMock.mock.calls[0][0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const ch of pickerCall.choices as any[]) {
      expect(String(ch.name)).not.toContain('ws_TESTw001');
      expect(String(ch.name)).not.toContain('ws_TESTw002');
    }
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pickerCall.choices.map((c: any) => c.name).join(' '),
    ).toMatch(/acme-corp/);
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('Next steps');
    logSpy.mockRestore();
  });

  it('zero workspaces → hint + no crash', async () => {
    apiClientMock.mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard();
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('hookmyapp workspace new');
    expect(out).not.toContain('Next steps');
    logSpy.mockRestore();
  });

  it('--next exit → no next-steps block, no sandbox/channels call', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ws_TEST0001',
        name: 'acme-corp',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard({ next: 'exit' });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('Next steps');
    expect(runSandboxListenFlowMock).not.toHaveBeenCalled();
    expect(runChannelsConnectMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('--next sandbox --phone matches existing → delegates to listen (Phase 126 bind-code model)', async () => {
    apiClientMock
      // workspaces fetch
      .mockResolvedValueOnce([
        {
          id: 'ws_TEST0001',
          name: 'acme',
          role: 'admin',
          workosOrganizationId: 'org_1',
        },
      ])
      // sandbox sessions fetch — the session already exists (bound previously
      // via `hookmyapp sandbox start`). Phase 126 no longer POSTs to
      // /sandbox/sessions; binding is inbound-message driven.
      .mockResolvedValueOnce([
        {
          id: 'ssn_TEST001',
          type: 'whatsapp',
          workspaceId: 'ws_TEST0001',
          phone: '15551234567',
          whatsappPhone: '+15551234567',
          whatsappPhoneNumberId: 'pnid_TEST001',
          sandboxPhoneNumberId: 'spnid_TEST001',
          whatsappApiVersion: 'v20.0',
          status: 'active',
          accessToken: 'abc12345',
          hmacSecret: 'secret',
          origin: 'sandbox',
        },
      ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard({ next: 'sandbox', phone: '+15551234567' });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('Next steps');
    // Confirms runSandboxFlow took the matching-existing-phone path.
    expect(apiClientMock).toHaveBeenCalledWith(
      '/sandbox/sessions?active=true',
      expect.objectContaining({ method: 'GET' }),
    );
    // Guardrail: no POST to the deleted /sandbox/sessions endpoint.
    for (const call of apiClientMock.mock.calls) {
      const [path, init] = call;
      if (path === '/sandbox/sessions' && init?.method === 'POST') {
        throw new Error(
          'Regression: wizard POSTed to /sandbox/sessions which was deleted in Phase 126 Plan 03',
        );
      }
    }
    expect(runSandboxListenFlowMock).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it('--next channels → delegates to runChannelsConnect', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ws_TEST0001',
        name: 'acme',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard({ next: 'channels' });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('Next steps');
    expect(runChannelsConnectMock).toHaveBeenCalledTimes(1);
    expect(runSandboxListenFlowMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('--json (no --next, no --phone) → emits JSON payload without nextSteps, suppresses human block', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'ws_TEST0001',
        name: 'acme-corp',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    await runWizard({ json: true });
    // Find the JSON payload among all write() calls (ignore any non-JSON writes).
    const writes = writeSpy.mock.calls.map((args) => String(args[0]));
    const payloadLine = writes.find((w) => w.trim().startsWith('{'));
    expect(payloadLine).toBeDefined();
    const payload = JSON.parse((payloadLine as string).trim());
    expect(payload.ok).toBe(true);
    expect(payload.workspaceId).toBe('ws_TEST0001');
    expect(payload.next).toBe('exit');
    expect('nextSteps' in payload).toBe(false);
    const humanOut = logSpy.mock.calls.flat().join('\n');
    expect(humanOut).not.toContain('Next steps');
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });
});
