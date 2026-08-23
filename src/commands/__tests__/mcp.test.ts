import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runTool } from '../../lib/spawn-tool.js';
import { Command } from 'commander';
import { resolve } from 'node:path';
import { getMcpAccessToken } from '../../auth/mcp-credential.js';

// Mock the tool-spawn seam, not node:child_process: `runTool` adds the
// cmd.exe /c prefix on Windows, so asserting raw runTool argv here is a
// platform-dependent test, not a contract test (AIT-395).
vi.mock('../../lib/spawn-tool.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/spawn-tool.js')>()),
  runTool: vi.fn(),
}));
vi.mock('../../auth/mcp-credential.js', () => ({ getMcpAccessToken: vi.fn() }));
vi.mock('../../config/env-profiles.js', () => ({
  getEffectiveApiUrl: () => 'https://api.hookmyapp.com',
}));

import {
  installClaudeMcp,
  printMcpHeaders,
  registerMcpCommand,
  removeClaudeMcp,
  shellQuote,
} from '../mcp.js';

describe('MCP setup', () => {
  beforeEach(() => vi.clearAllMocks());

  test('prints only the dynamic Authorization header JSON', async () => {
    vi.mocked(getMcpAccessToken).mockResolvedValue('hmok_test');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await printMcpHeaders();

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('{"Authorization":"Bearer hmok_test"}\n');
  });

  test('installs a user-scoped Claude headersHelper without storing a token', () => {
    vi.mocked(runTool).mockReturnValue({ status: 0 } as never);

    installClaudeMcp();

    const [, args] = vi.mocked(runTool).mock.calls[0];
    expect(args).toEqual([
      'mcp',
      'add-json',
      '--scope',
      'user',
      'hookmyapp',
      JSON.stringify({
        type: 'http',
        url: 'https://api.hookmyapp.com/mcp',
        headersHelper: `${shellQuote(process.execPath)} ${shellQuote(resolve(process.argv[1]))} mcp-headers`,
      }),
    ]);
    expect(JSON.stringify(args)).not.toContain('Bearer');
  });

  test('shell-quotes helper paths without expanding metacharacters', () => {
    expect(shellQuote('/tmp/$(`unsafe`)/it\'s', 'linux')).toBe(`'/tmp/$(\`unsafe\`)/it'"'"'s'`);
    expect(shellQuote('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(
      '"C:\\Program Files\\nodejs\\node.exe"',
    );
  });

  test('replaces an existing Claude entry', () => {
    vi.mocked(runTool)
      .mockReturnValueOnce({ status: 1, stderr: 'already exists' } as never)
      .mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 0 } as never);

    installClaudeMcp();

    expect(runTool).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runTool).mock.calls[1][1]).toEqual(['mcp', 'remove', '--scope', 'user', 'hookmyapp']);
  });

  test('removes only the user-scoped HookMyApp entry', () => {
    vi.mocked(runTool).mockReturnValue({ status: 0 } as never);

    removeClaudeMcp(true);

    expect(runTool).toHaveBeenCalledWith('claude', ['mcp', 'remove', '--scope', 'user', 'hookmyapp'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  });

  test('treats missing Claude as successful cleanup', () => {
    vi.mocked(runTool).mockReturnValue({
      status: null,
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    } as never);

    expect(removeClaudeMcp(true)).toEqual({ ok: true });
  });

  test('treats an absent MCP entry as successful cleanup', () => {
    vi.mocked(runTool).mockReturnValue({ status: 1, stderr: 'MCP server hookmyapp not found' } as never);

    expect(removeClaudeMcp(true)).toEqual({ ok: true });
  });

  test('reports a bounded Claude status timeout', async () => {
    vi.mocked(runTool).mockReturnValue({
      status: null,
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    } as never);
    const { getClaudeMcpStatus } = await import('../mcp.js');

    expect(getClaudeMcpStatus()).toEqual({ ok: false, detail: 'Claude MCP check timed out' });
    expect(vi.mocked(runTool).mock.calls[0][2]).toMatchObject({ timeout: 10_000 });
  });

  test('emits JSON for mcp install in global JSON mode', async () => {
    vi.mocked(runTool).mockReturnValue({ status: 0 } as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().option('--json');
    registerMcpCommand(program);

    await program.parseAsync(['node', 'hookmyapp', '--json', 'mcp', 'install', '--agent', 'claude']);

    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual({ status: 'configured', agent: 'claude' });
  });
});
