import { expect, test, beforeEach, afterEach, vi } from 'vitest';

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
  apiClientMock.mockReset();
  confirmMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

test('list --json prints the credentials array', async () => {
  apiClientMock.mockResolvedValue([{ publicId: 'ac_pub1', scopes: ['workspace.read'] }]);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await run(['credentials', 'list', '--json']);
  expect(apiClientMock).toHaveBeenCalledWith('/agent/credentials');
  expect(JSON.parse(logSpy.mock.calls.flat().join('\n'))).toEqual([{ publicId: 'ac_pub1', scopes: ['workspace.read'] }]);
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
