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

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: mocks.writeFileSyncMock,
    existsSync: mocks.existsSyncMock,
  };
});

const EXPECTED_ENV_BLOCK = `VERIFY_TOKEN=HMAC_yyy
PORT=3000
WHATSAPP_API_URL=https://sandbox.hookmyapp.com/v22.0
WHATSAPP_ACCESS_TOKEN=ACT_xxx
WHATSAPP_PHONE_NUMBER_ID=15551234567
`;

function seedSession() {
  mocks.apiClientMock.mockResolvedValueOnce([
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
        id: 'sess-a',
        phone: '15551234567',
        activationCode: 'ACT_xxx',
        hmacSecret: 'HMAC_yyy',
        status: 'active',
        workspaceId: 'w1',
      },
      {
        id: 'sess-b',
        phone: '15559999999',
        activationCode: 'ACT_other',
        hmacSecret: 'HMAC_other',
        status: 'active',
        workspaceId: 'w1',
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
