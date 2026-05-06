import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  apiClientMock: vi.fn(),
  resolveChannelMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
  readFileSyncMock: vi.fn<(p: string, enc: string) => string>(() => ''),
  existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
}));

vi.mock('../../api/client.js', () => ({ apiClient: mocks.apiClientMock }));
vi.mock('../channels.js', () => ({ resolveChannel: mocks.resolveChannelMock }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: mocks.writeFileSyncMock,
    renameSync: mocks.renameSyncMock,
    readFileSync: mocks.readFileSyncMock,
    existsSync: mocks.existsSyncMock,
  };
});

async function runEnv(args: string[]) {
  vi.resetModules();
  const { registerEnvCommand } = await import('../env.js');
  const program = new Command();
  program.exitOverride();
  registerEnvCommand(program);
  await program.parseAsync(['node', 'hookmyapp', 'env', ...args]);
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => 'mockReset' in m && m.mockReset());
  mocks.existsSyncMock.mockReturnValue(false);
  mocks.readFileSyncMock.mockReturnValue('');
  mocks.resolveChannelMock.mockResolvedValue({
    id: 'ch_1',
    metaWabaId: '1234567890',
    phoneNumberId: '15551234567',
  });
  mocks.apiClientMock.mockResolvedValue({ accessToken: 'ACT_xxx' });
});

describe('env <waba-id> — WHATSAPP_ prefix', () => {
  it('prints all three keys with WHATSAPP_ prefix to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runEnv(['1234567890']);
    const out = writeSpy.mock.calls.flat().join('');
    expect(out).toContain('WHATSAPP_WABA_ID=1234567890');
    expect(out).toContain('WHATSAPP_ACCESS_TOKEN=ACT_xxx');
    expect(out).toContain('WHATSAPP_PHONE_NUMBER_ID=15551234567');
    expect(out).not.toMatch(/^WABA_ID=/m);
    expect(out).not.toMatch(/^ACCESS_TOKEN=/m);
    expect(out).not.toMatch(/^PHONE_NUMBER_ID=/m);
    writeSpy.mockRestore();
  });
});
