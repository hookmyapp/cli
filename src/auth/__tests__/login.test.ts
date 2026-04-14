import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 0 RED: asserts the post-login wizard contract from CONTEXT.md §
// "Wizard flow steps 1-4". runWizard isn't exported from src/auth/login.ts
// yet, so these tests fail on "runWizard is not a function".

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

const writeWorkspaceConfigMock = vi.fn();
vi.mock('../../commands/workspace.js', () => ({
  writeWorkspaceConfig: writeWorkspaceConfigMock,
  readWorkspaceConfig: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runWizard: any;

beforeEach(async () => {
  selectMock.mockReset();
  inputMock.mockReset();
  confirmMock.mockReset();
  apiClientMock.mockReset();
  writeWorkspaceConfigMock.mockReset();
  vi.resetModules();
  const mod = await import('../login.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runWizard = (mod as any).runWizard;
});

describe('post-login wizard — Wave 0 RED', () => {
  it('single workspace → silent select (no picker call)', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'w1',
        name: 'acme-corp',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
    ]);
    selectMock.mockResolvedValueOnce('exit'); // next-action picker
    await runWizard();
    // Only one select call: next-action. Workspace auto-selected.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(writeWorkspaceConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkspaceId: 'w1',
        activeWorkspaceSlug: 'acme-corp',
      }),
    );
  });

  it('multi workspace → picker shows names, not UUIDs', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'w1-uuid',
        name: 'acme-corp',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
      {
        id: 'w2-uuid',
        name: 'beta-workspace',
        role: 'member',
        workosOrganizationId: 'org_2',
      },
    ]);
    selectMock.mockResolvedValueOnce({ id: 'w1-uuid', name: 'acme-corp' }); // picker
    selectMock.mockResolvedValueOnce('exit'); // next-action
    await runWizard();
    const pickerCall = selectMock.mock.calls[0][0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of pickerCall.choices as any[]) {
      expect(String(c.name)).not.toContain('w1-uuid');
      expect(String(c.name)).not.toContain('w2-uuid');
    }
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pickerCall.choices.map((c: any) => c.name).join(' '),
    ).toMatch(/acme-corp/);
  });

  it('next-action defaults to sandbox', async () => {
    apiClientMock.mockResolvedValueOnce([
      {
        id: 'w1',
        name: 'acme',
        role: 'admin',
        workosOrganizationId: 'org_1',
      },
    ]);
    selectMock.mockResolvedValueOnce('exit');
    await runWizard();
    const nextCall = selectMock.mock.calls[0][0];
    expect(nextCall.default).toBe('sandbox');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sandboxChoice = nextCall.choices.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c.value === 'sandbox',
    );
    expect(sandboxChoice).toBeDefined();
    expect(String(sandboxChoice.name)).toMatch(/Start sandbox session/i);
  });

  it('zero workspaces → hint + no crash', async () => {
    apiClientMock.mockResolvedValueOnce([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runWizard();
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('hookmyapp workspace new');
    logSpy.mockRestore();
  });
});
