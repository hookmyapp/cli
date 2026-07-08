import { expect, test, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let DIR: string;
const SAVED_DIR = process.env.HOOKMYAPP_CONFIG_DIR;

const apiClientMock = vi.fn();
vi.mock('../../api/client.js', () => ({ apiClient: (...a: unknown[]) => apiClientMock(...a) }));
const confirmMock = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  confirm: (...a: unknown[]) => confirmMock(...a),
  select: vi.fn(),
  input: vi.fn(),
}));

async function run(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();
  program.option('--json');
  program.option('--human');
  const { registerCredentialsCommand } = await import('../credentials.js');
  registerCredentialsCommand(program);
  await program.parseAsync(['node', 'hookmyapp', ...argv]);
}

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'hma-creds-cmd-'));
  process.env.HOOKMYAPP_CONFIG_DIR = DIR;
  apiClientMock.mockReset();
  confirmMock.mockReset();
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  if (SAVED_DIR) process.env.HOOKMYAPP_CONFIG_DIR = SAVED_DIR;
  else delete process.env.HOOKMYAPP_CONFIG_DIR;
  vi.restoreAllMocks();
});

test('list --json prints the credentials array', async () => {
  apiClientMock.mockResolvedValue([{ publicId: 'ac_pub1', scopes: ['workspace.read'] }]);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await run(['credentials', 'list', '--json']);
  expect(apiClientMock).toHaveBeenCalledWith('/agent/credentials');
  expect(JSON.parse(logSpy.mock.calls.flat().join('\n'))).toEqual([{ publicId: 'ac_pub1', scopes: ['workspace.read'] }]);
  logSpy.mockRestore();
});

test('list human rows include the credential name', async () => {
  apiClientMock.mockResolvedValue([
    { publicId: 'ac_pub1', name: 'ci-bot', scopes: ['workspace.read'] },
    { publicId: 'ac_pub2', name: null, scopes: ['workspace.read'] },
  ]);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await run(['credentials', 'list']);
  const out = logSpy.mock.calls.flat().join('\n');
  expect(out).toContain('ac_pub1  ci-bot  workspace.read');
  expect(out).toContain('ac_pub2  (unnamed)  workspace.read');
  logSpy.mockRestore();
});

test('revoke <id> -y DELETEs without prompting', async () => {
  apiClientMock.mockResolvedValue(undefined);
  await run(['credentials', 'revoke', 'ac_pub1', '-y']);
  expect(confirmMock).not.toHaveBeenCalled();
  expect(apiClientMock).toHaveBeenCalledWith('/agent/credentials/ac_pub1', { method: 'DELETE' });
});

test('revoke <id> aborts when the user declines the prompt', async () => {
  confirmMock.mockResolvedValue(false);
  await run(['credentials', 'revoke', 'ac_pub1']);
  expect(apiClientMock).not.toHaveBeenCalled();
});

test('revoking the currently stored credential clears it from disk', async () => {
  writeFileSync(
    join(DIR, 'credentials.json'),
    JSON.stringify({ accessToken: 'ac_x', refreshToken: '', expiresAt: 0, kind: 'agent', credentialPublicId: 'ac_pub1', scopes: [] }),
  );
  apiClientMock.mockResolvedValue(undefined);
  await run(['credentials', 'revoke', 'ac_pub1', '-y', '--json']);
  expect(existsSync(join(DIR, 'credentials.json'))).toBe(false);
});

test('revoking a different credential leaves the stored one intact', async () => {
  writeFileSync(
    join(DIR, 'credentials.json'),
    JSON.stringify({ accessToken: 'ac_x', refreshToken: '', expiresAt: 0, kind: 'agent', credentialPublicId: 'ac_pub1', scopes: [] }),
  );
  apiClientMock.mockResolvedValue(undefined);
  await run(['credentials', 'revoke', 'ac_other', '-y', '--json']);
  expect(existsSync(join(DIR, 'credentials.json'))).toBe(true);
});
