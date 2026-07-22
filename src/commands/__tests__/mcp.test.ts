import { beforeEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { getValidAccessToken } from '../../api/client.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('../../api/client.js', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('../../config/env-profiles.js', () => ({
  getEffectiveApiUrl: () => 'https://api.hookmyapp.com',
}));

import { installClaudeMcp, maybeInstallClaudeMcp, printMcpHeaders, removeClaudeMcp } from '../mcp.js';

describe('MCP setup', () => {
  beforeEach(() => vi.clearAllMocks());

  test('prints only the dynamic Authorization header JSON', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('hmok_test');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await printMcpHeaders();

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('{"Authorization":"Bearer hmok_test"}\n');
  });

  test('installs a user-scoped Claude headersHelper without storing a token', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);

    installClaudeMcp();

    const [, args] = vi.mocked(spawnSync).mock.calls[0];
    expect(args).toEqual([
      'mcp',
      'add-json',
      '--scope',
      'user',
      'hookmyapp',
      JSON.stringify({
        type: 'http',
        url: 'https://api.hookmyapp.com/mcp',
        headersHelper: 'hookmyapp mcp-headers',
      }),
    ]);
    expect(JSON.stringify(args)).not.toContain('Bearer');
  });

  test('skips automatic setup when Claude Code is absent', () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      status: null,
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    } as never);

    maybeInstallClaudeMcp(true);

    expect(spawnSync).toHaveBeenCalledOnce();
  });

  test('replaces an existing Claude entry', () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 1, stderr: 'already exists' } as never)
      .mockReturnValueOnce({ status: 0 } as never)
      .mockReturnValueOnce({ status: 0 } as never);

    installClaudeMcp();

    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(vi.mocked(spawnSync).mock.calls[1][1]).toEqual(['mcp', 'remove', '--scope', 'user', 'hookmyapp']);
  });

  test('removes only the user-scoped HookMyApp entry', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);

    removeClaudeMcp(true);

    expect(spawnSync).toHaveBeenCalledWith('claude', ['mcp', 'remove', '--scope', 'user', 'hookmyapp'], {
      encoding: 'utf8',
    });
  });
});
