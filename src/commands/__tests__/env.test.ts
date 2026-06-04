import { describe, it, test, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  apiClientMock: vi.fn(),
  resolveChannelMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
  readFileSyncMock: vi.fn<(p: string, enc: string) => string>(() => ''),
  existsSyncMock: vi.fn<(p: string) => boolean>(() => false),
}));

vi.mock('../../api/client.js', () => ({ apiClient: mocks.apiClientMock, setWorkspaceContext: vi.fn() }));
vi.mock('../channels.js', () => ({ resolveChannel: mocks.resolveChannelMock }));
// The --write path calls createKeyForChannel (in keys.ts), which itself calls
// resolveChannel + an apiClient POST. Mock it so the --write mint integration
// doesn't fire an out-of-sequence POST / extra resolveChannel and break the
// call-order assertions below. Path is `../keys.js` — vi.mock resolves relative
// to THIS test file at src/commands/__tests__/, so a sibling module in
// src/commands/ is `../` (matches vi.mock('../channels.js') above).
vi.mock('../keys.js', () => ({
  createKeyForChannel: vi.fn(async () => ({
    key: 'hmp_live_TESTKEY',
    publicId: 'key_TEST0001',
    keyPrefix: 'hmp_live_TEST',
    keySuffix: 'EY01',
  })),
}));
// Mock isJsonMode so we can toggle per-test without commander gymnastics.
// Mirrors the pattern in token.test.ts (Task 4). Existing human-mode tests
// fall through to `() => false`.
vi.mock('../../output/format.js', async (orig) => ({
  ...(await orig<object>()),
  isJsonMode: vi.fn(() => false),
}));
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

// runChannelEnv now consumes the gateway /meta/channels/:id/env payload —
// { channelType, values, defaults, hasActiveKey }. The GET NEVER returns the
// real Meta token: `values` carries the gateway base URL (META_GRAPH_API_URL)
// plus non-secret keys (WABA id, phone number id). On --write the CLI mints a
// gateway key (createKeyForChannel) and injects it under the channel-type's
// token key; without --write the token field shows a `<run: ...>` hint.
const ENV_PAYLOAD = {
  channelType: 'whatsapp',
  values: {
    META_GRAPH_API_URL: 'https://gateway.hookmyapp.com/v22.0',
    WHATSAPP_WABA_ID: '1234567890',
    WHATSAPP_PHONE_NUMBER_ID: '15551234567',
  },
  defaults: { PORT: '3000' },
  hasActiveKey: false,
};

async function runEnv(args: string[]) {
  vi.resetModules();
  const { runChannelEnv } = await import('../env.js');
  const channelRef = args[0];
  const writeIndex = args.indexOf('--write');
  const write =
    writeIndex === -1 ? undefined : (args[writeIndex + 1] ?? true);
  await runChannelEnv(channelRef, { write });
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => 'mockReset' in m && m.mockReset());
  mocks.existsSyncMock.mockReturnValue(false);
  mocks.readFileSyncMock.mockReturnValue('');
  mocks.resolveChannelMock.mockResolvedValue({
    id: 'ch_1',
    workspaceId: 'ws_TEST0001',
    metaWabaId: '1234567890',
    whatsappPhoneNumberId: '15551234567',
  });
  mocks.apiClientMock.mockResolvedValue(ENV_PAYLOAD);
});

describe('env <channel> — WHATSAPP_ prefix', () => {
  it('prints gateway URL + non-secret keys, token field as a hint (never a real token)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runEnv(['ch_1']);
    const out = writeSpy.mock.calls.flat().join('');
    expect(out).toContain('META_GRAPH_API_URL=https://gateway.hookmyapp.com/v22.0');
    expect(out).toContain('WHATSAPP_WABA_ID=1234567890');
    expect(out).toContain('WHATSAPP_PHONE_NUMBER_ID=15551234567');
    // Token field present, but as a run-hint — never a real token, never the minted key.
    expect(out).toContain('WHATSAPP_ACCESS_TOKEN=<run: hookmyapp keys create ch_1>');
    expect(out).not.toContain('hmp_live_TESTKEY');
    expect(out).not.toMatch(/^WABA_ID=/m);
    expect(out).not.toMatch(/^ACCESS_TOKEN=/m);
    expect(out).not.toMatch(/^PHONE_NUMBER_ID=/m);
    writeSpy.mockRestore();
  });
});

describe('env <channel> --write — upsert-merge', () => {
  it('writes gateway URL + non-secret keys + minted key when target file is missing', async () => {
    mocks.existsSyncMock.mockReturnValue(false);
    await runEnv(['ch_1', '--write', '.env']);
    expect(mocks.writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [tmpPath, contents] = mocks.writeFileSyncMock.mock.calls[0];
    expect(String(tmpPath)).toMatch(/\.env\.tmp$/);
    expect(String(contents)).toContain('META_GRAPH_API_URL=https://gateway.hookmyapp.com/v22.0');
    expect(String(contents)).toContain('WHATSAPP_WABA_ID=1234567890');
    expect(String(contents)).toContain('WHATSAPP_ACCESS_TOKEN=hmp_live_TESTKEY');
    expect(String(contents)).toContain('WHATSAPP_PHONE_NUMBER_ID=15551234567');
    expect(mocks.renameSyncMock).toHaveBeenCalledTimes(1);
    const [from, to] = mocks.renameSyncMock.mock.calls[0];
    expect(String(from)).toMatch(/\.env\.tmp$/);
    expect(String(to)).toMatch(/\.env$/);
  });

  it('preserves unrelated keys and appends the new keys (with the minted token)', async () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockReturnValue('PORT=4000\nVERIFY_TOKEN=abc\n');
    await runEnv(['ch_1', '--write', '.env']);
    const contents = String(mocks.writeFileSyncMock.mock.calls[0][1]);
    expect(contents).toContain('PORT=4000');
    expect(contents).toContain('VERIFY_TOKEN=abc');
    expect(contents).toContain('META_GRAPH_API_URL=https://gateway.hookmyapp.com/v22.0');
    expect(contents).toContain('WHATSAPP_WABA_ID=1234567890');
    expect(contents).toContain('WHATSAPP_ACCESS_TOKEN=hmp_live_TESTKEY');
    expect(contents).toContain('WHATSAPP_PHONE_NUMBER_ID=15551234567');
  });

  it('replaces a prior WHATSAPP_ACCESS_TOKEN value with the minted key, leaves others alone', async () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockReturnValue(
      'PORT=4000\nWHATSAPP_ACCESS_TOKEN=old\nVERIFY_TOKEN=abc\n',
    );
    await runEnv(['ch_1', '--write', '.env']);
    const contents = String(mocks.writeFileSyncMock.mock.calls[0][1]);
    expect(contents).toContain('WHATSAPP_ACCESS_TOKEN=hmp_live_TESTKEY');
    expect(contents).not.toContain('WHATSAPP_ACCESS_TOKEN=old');
    expect(contents).toContain('PORT=4000');
    expect(contents).toContain('VERIFY_TOKEN=abc');
  });

  it('mints the key on disk only — no stray plaintext key line on stdout', async () => {
    mocks.existsSyncMock.mockReturnValue(false);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runEnv(['ch_1', '--write', '.env']);
    const stdout = stdoutSpy.mock.calls.flat().join('');
    // The minted key lands in the written file, NOT as a stdout line.
    expect(stdout).not.toContain('hmp_live_TESTKEY');
    const contents = String(mocks.writeFileSyncMock.mock.calls[0][1]);
    expect(contents).toContain('WHATSAPP_ACCESS_TOKEN=hmp_live_TESTKEY');
    stdoutSpy.mockRestore();
  });

  it('preserves comments and ordering of unrelated lines', async () => {
    mocks.existsSyncMock.mockReturnValue(true);
    mocks.readFileSyncMock.mockReturnValue(
      '# header comment\nPORT=4000\n\n# section\nVERIFY_TOKEN=abc\n',
    );
    await runEnv(['ch_1', '--write', '.env']);
    const contents = String(mocks.writeFileSyncMock.mock.calls[0][1]);
    const lines = contents.split('\n');
    expect(lines[0]).toBe('# header comment');
    expect(lines[1]).toBe('PORT=4000');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('# section');
    expect(lines[4]).toBe('VERIFY_TOKEN=abc');
  });

  it('writes atomically: writeFileSync to .tmp then renameSync into place', async () => {
    mocks.existsSyncMock.mockReturnValue(false);
    await runEnv(['ch_1', '--write', '.env']);
    const writeOrder = mocks.writeFileSyncMock.mock.invocationCallOrder[0];
    const renameOrder = mocks.renameSyncMock.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
  });
});

describe('runChannelEnv --json (D6)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // IG-style payload — matches the cleanup spec's example shape. PORT was
  // dropped from defaults server-side in Phase A; the test asserts it does
  // NOT appear in the merged output.
  const IG_PAYLOAD = {
    channelType: 'instagram',
    values: {
      INSTAGRAM_GRAPH_API_URL: 'https://graph.instagram.com/v25.0',
      INSTAGRAM_ACCESS_TOKEN: 'IGAAi_test_token',
      INSTAGRAM_USER_ID: '17841999999999999',
      HOOKMYAPP_CHANNEL_ID: 'ch_TEST0001',
      VERIFY_TOKEN: 'test123',
    },
    defaults: {},
  };

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.resolveChannelMock.mockResolvedValue({
      id: 'ch_TEST0001',
      type: 'instagram',
      workspaceId: 'ws_TEST0001',
    });
    mocks.apiClientMock.mockResolvedValue(IG_PAYLOAD);
    const { isJsonMode } = await import('../../output/format.js');
    vi.mocked(isJsonMode).mockReset();
  });

  test('When --json, then output is a flat {KEY: VALUE} object', async () => {
    const { isJsonMode } = await import('../../output/format.js');
    vi.mocked(isJsonMode).mockReturnValue(true);
    const { runChannelEnv } = await import('../env.js');
    // Pass an opaque Command stub — runChannelEnv only forwards it to isJsonMode.
    await runChannelEnv('ch_TEST0001', {}, {} as Command);
    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({
      INSTAGRAM_GRAPH_API_URL: 'https://graph.instagram.com/v25.0',
      INSTAGRAM_ACCESS_TOKEN: 'IGAAi_test_token',
      INSTAGRAM_USER_ID: '17841999999999999',
      HOOKMYAPP_CHANNEL_ID: 'ch_TEST0001',
      VERIFY_TOKEN: 'test123',
    });
    expect(parsed).not.toHaveProperty('PORT');
  });

  test('When human mode, then output is dotenv text (unchanged)', async () => {
    const { isJsonMode } = await import('../../output/format.js');
    vi.mocked(isJsonMode).mockReturnValue(false);
    const { runChannelEnv } = await import('../env.js');
    await runChannelEnv('ch_TEST0001', {}, {} as Command);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('INSTAGRAM_ACCESS_TOKEN=IGAAi_test_token');
    expect(() => JSON.parse(output)).toThrow();  // not JSON
  });
});
