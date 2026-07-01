import { expect, test, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let DIR: string;
const SAVED_DIR = process.env.HOOKMYAPP_CONFIG_DIR;
const SAVED_API_URL = process.env.HOOKMYAPP_API_URL;
function okJson(b: unknown, s = 200): Response {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function readCreds() {
  return JSON.parse(readFileSync(join(DIR, 'credentials.json'), 'utf-8'));
}

const inputMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  input: (...a: unknown[]) => inputMock(...a),
  select: vi.fn(),
  confirm: vi.fn(),
}));

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hma-agentlogin-'));
  process.env.HOOKMYAPP_CONFIG_DIR = DIR;
  process.env.HOOKMYAPP_API_URL = 'https://test.example.com';
  inputMock.mockReset();
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SAVED_DIR) process.env.HOOKMYAPP_CONFIG_DIR = SAVED_DIR;
  else delete process.env.HOOKMYAPP_CONFIG_DIR;
  if (SAVED_API_URL) process.env.HOOKMYAPP_API_URL = SAVED_API_URL;
  else delete process.env.HOOKMYAPP_API_URL;
  vi.unstubAllGlobals();
});

test('interactive: claims with full scopes, prompts OTP, completes, saves ac_ credential', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(okJson({ scopes_supported: ['workspace.read', 'message.send'] })) // discovery
    .mockResolvedValueOnce(okJson({ registrationId: '11111111-1111-1111-1111-111111111111', expiresAt: 'x', message: 'sent' }, 202)) // claim
    .mockResolvedValueOnce(okJson({ accessToken: 'ac_live_x', tokenType: 'Bearer', scopes: ['workspace.read', 'message.send'], credentialPublicId: 'ac_pub1' })); // complete
  vi.stubGlobal('fetch', fetchMock);
  inputMock.mockResolvedValue('123456');
  const origIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const mod = await import('../login.js');

  try {
    await mod.runAgentClaimLogin({ email: 'a@b.com' });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).scopes).toEqual(['workspace.read', 'message.send']);
    const creds = readCreds();
    expect(creds.accessToken).toBe('ac_live_x');
    expect(creds.kind).toBe('agent');
    expect(creds.credentialPublicId).toBe('ac_pub1');
  } finally {
    logSpy.mockRestore();
    if (origIsTty) Object.defineProperty(process.stdin, 'isTTY', origIsTty);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  }
});

test('json step 2 without --otp is a ValidationError and never calls the network', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const mod = await import('../login.js');
  await expect(
    mod.runAgentClaimLogin({ email: 'a@b.com', registrationId: '2222', json: true }),
  ).rejects.toMatchObject({ exitCode: 2 });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(inputMock).not.toHaveBeenCalled();
});

test('json split step 1: no --otp prints registrationId + expiresAt and does NOT prompt or save', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(okJson({ scopes_supported: ['workspace.read'] }))
    .mockResolvedValueOnce(okJson({ registrationId: '2222', expiresAt: 'later', message: 'sent' }, 202));
  vi.stubGlobal('fetch', fetchMock);
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const mod = await import('../login.js');

  await mod.runAgentClaimLogin({ email: 'a@b.com', json: true });

  expect(inputMock).not.toHaveBeenCalled();
  expect(existsSync(join(DIR, 'credentials.json'))).toBe(false);
  const printed = outSpy.mock.calls.flat().join('');
  expect(JSON.parse(printed)).toMatchObject({ registrationId: '2222', expiresAt: 'later' });
  outSpy.mockRestore();
});

test('json split step 2: --registration-id + --otp completes without a new claim call', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    okJson({ accessToken: 'ac_live_y', tokenType: 'Bearer', scopes: ['workspace.read'], credentialPublicId: 'ac_pub2' }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const mod = await import('../login.js');

  await mod.runAgentClaimLogin({ email: 'a@b.com', registrationId: '2222', otp: '654321', json: true });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toBe('https://test.example.com/agent/auth/claim/complete');
  expect(readCreds().accessToken).toBe('ac_live_y');
});

test('--otp without --registration-id is a ValidationError (exit 2)', async () => {
  const mod = await import('../login.js');
  await expect(mod.runAgentClaimLogin({ email: 'a@b.com', otp: '123456' })).rejects.toMatchObject({ exitCode: 2 });
});

test('agent flags without --email are rejected before any browser flow', async () => {
  const { Command } = await import('commander');
  const { loginCommand } = await import('../login.js');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  program.option('--human');
  loginCommand(program);
  await expect(
    program.parseAsync(['node', 'hookmyapp', 'login', '--registration-id', 'r1', '--otp', '123456', '--json']),
  ).rejects.toMatchObject({ exitCode: 2 });
  expect(fetchMock).not.toHaveBeenCalled();
});
