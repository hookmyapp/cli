import { describe, it, expect, vi, beforeEach } from 'vitest';

// Wave 0 RED: the `sandbox env` subcommand does not exist yet in
// src/commands/sandbox.ts. Importing `runSandboxEnv` fails, producing
// "not a function" errors across every case below.

const mocks = vi.hoisted(() => ({
  inputMock: vi.fn(),
  confirmMock: vi.fn(),
  selectMock: vi.fn(),
  apiClientMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
}));

vi.mock('@inquirer/prompts', () => ({
  input: mocks.inputMock,
  confirm: mocks.confirmMock,
  select: mocks.selectMock,
}));

vi.mock('../../api/client.js', () => ({
  apiClient: mocks.apiClientMock,
  forceTokenRefresh: vi.fn(),
}));

// Seed an active workspace so `_helpers.getDefaultWorkspaceId` resolves from
// config instead of making its own `apiClient('/workspaces')` call. Without
// this mock, the seedSession mock queue would be consumed by the workspace
// fetch rather than the session fetch. Mirrors the approach in
// src/commands/__tests__/wizard.test.ts.
vi.mock('../workspace.js', () => ({
  readWorkspaceConfig: () => ({
    activeWorkspaceId: 'ws_TEST0001',
    activeWorkspaceSlug: 'acme-corp',
  }),
  writeWorkspaceConfig: vi.fn(),
  registerWorkspaceCommand: vi.fn(),
  resolveWorkspace: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: mocks.writeFileSyncMock,
    existsSync: mocks.existsSyncMock,
  };
});

// Proxy host comes from env-profiles default (production → sandbox.hookmyapp.com).
// Graph API version is server-delivered on the session (whatsappApiVersion).
const EXPECTED_ENV_BLOCK = `VERIFY_TOKEN=HMAC_yyy
PORT=3000
WHATSAPP_API_URL=https://sandbox.hookmyapp.com/v24.0
WHATSAPP_ACCESS_TOKEN=ACT_xxx
WHATSAPP_PHONE_NUMBER_ID=15551234567
`;

function seedSession() {
  mocks.apiClientMock.mockResolvedValueOnce([
    {
      id: 'ssn_TEST001',
      phone: '15551234567',
      accessToken: 'ACT_xxx',
      hmacSecret: 'HMAC_yyy',
      status: 'active',
      workspaceId: 'ws_TEST0001',
      whatsappApiVersion: 'v24.0',
    },
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runSandboxEnv: any;

beforeEach(async () => {
  mocks.inputMock.mockReset();
  mocks.confirmMock.mockReset();
  mocks.selectMock.mockReset();
  mocks.apiClientMock.mockReset();
  mocks.writeFileSyncMock.mockReset();
  mocks.existsSyncMock.mockReset();
  mocks.existsSyncMock.mockReturnValue(false);
  vi.resetModules();
  const mod = await import('../sandbox.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runSandboxEnv = (mod as any).runSandboxEnv;
});

describe('sandbox env — Wave 0 RED (canonical env block)', () => {
  it('prints exact canonical block to stdout (default, no flags)', async () => {
    seedSession();
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxEnv({});
    const out =
      writeSpy.mock.calls.flat().join('') +
      logSpy.mock.calls.flat().join('\n');
    expect(out).toContain(EXPECTED_ENV_BLOCK);
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('--write prompts confirm when .env exists and declines if user says no', async () => {
    seedSession();
    mocks.existsSyncMock.mockReturnValueOnce(true);
    mocks.confirmMock.mockResolvedValueOnce(false);
    await runSandboxEnv({ write: true });
    expect(mocks.confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        default: false,
        message: expect.stringMatching(/already exists/i),
      }),
    );
    expect(mocks.writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('--write --force overwrites existing .env without prompting', async () => {
    seedSession();
    mocks.existsSyncMock.mockReturnValueOnce(true);
    await runSandboxEnv({ write: true, force: true });
    expect(mocks.confirmMock).not.toHaveBeenCalled();
    expect(mocks.writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.env$/),
      EXPECTED_ENV_BLOCK,
    );
  });

  it('--write=.env.sandbox writes to that path (not ./.env)', async () => {
    seedSession();
    mocks.existsSyncMock.mockReturnValueOnce(false);
    await runSandboxEnv({ write: '.env.sandbox' });
    expect(mocks.writeFileSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/\.env\.sandbox$/),
      EXPECTED_ENV_BLOCK,
    );
  });

  it('--json + --write on existing file without --force throws ValidationError (no prompt)', async () => {
    seedSession();
    mocks.existsSyncMock.mockReturnValueOnce(true);
    const { ValidationError } = await import('../../output/error.js');
    await expect(
      runSandboxEnv({ write: true, json: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ).rejects.toBeInstanceOf(ValidationError as any);
    expect(mocks.confirmMock).not.toHaveBeenCalled();
  });

  it('--phone +15551234567 skips session picker', async () => {
    mocks.apiClientMock.mockResolvedValueOnce([
      {
        id: 'ssn_TESTa01',
        phone: '15551234567',
        accessToken: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'ws_TEST0001',
      },
      {
        id: 'ssn_TESTb01',
        phone: '15559999999',
        accessToken: 'ACT_other',
        hmacSecret: 'HMAC_other',
        status: 'active',
        workspaceId: 'ws_TEST0001',
      },
    ]);
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    await runSandboxEnv({ phone: '+15551234567' });
    expect(mocks.selectMock).not.toHaveBeenCalled();
    const out = writeSpy.mock.calls.flat().join('');
    expect(out).toContain('WHATSAPP_PHONE_NUMBER_ID=15551234567');
    expect(out).not.toContain('WHATSAPP_PHONE_NUMBER_ID=15559999999');
    writeSpy.mockRestore();
  });
});
