// AIT-395 — Windows can't resolve `.cmd` shims from a bare command name.
// The customer's own probe, which this helper is built against:
//   spawnSync('claude', ['--version'])      → ENOENT (no PATHEXT expansion)
//   spawnSync('claude.cmd', ['--version'])  → EINVAL (.cmd needs cmd.exe)
//   shell: true                             → concatenates, mangling JSON args
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })) }));

import { isCommandNotFound, runTool } from '../spawn-tool.js';

const OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };

describe('runTool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('spawns the command directly on posix', () => {
    runTool('claude', ['--version'], OPTIONS, 'darwin');
    expect(spawnSync).toHaveBeenCalledWith('claude', ['--version'], OPTIONS);
  });

  it('routes through cmd.exe /c on win32 so .cmd shims resolve', () => {
    process.env.ComSpec = 'C:\\WINDOWS\\system32\\cmd.exe';
    runTool('claude', ['--version'], OPTIONS, 'win32');
    expect(spawnSync).toHaveBeenCalledWith(
      'C:\\WINDOWS\\system32\\cmd.exe',
      ['/c', 'claude', '--version'],
      OPTIONS,
    );
  });

  it('falls back to cmd.exe when ComSpec is unset', () => {
    delete process.env.ComSpec;
    runTool('npm', ['-v'], OPTIONS, 'win32');
    expect(spawnSync).toHaveBeenCalledWith('cmd.exe', ['/c', 'npm', '-v'], OPTIONS);
  });

  it('keeps a JSON argument as ONE argv entry (shell:true would concatenate it)', () => {
    const json = JSON.stringify({ type: 'http', url: 'https://api.hookmyapp.com/mcp' });
    runTool('claude', ['mcp', 'add-json', '--scope', 'user', 'hookmyapp', json], OPTIONS, 'win32');
    const [, args, options] = vi.mocked(spawnSync).mock.calls[0];
    expect(args).toEqual(['/c', 'claude', 'mcp', 'add-json', '--scope', 'user', 'hookmyapp', json]);
    // shell:true is what mangles the payload — it must never be set.
    expect(options).not.toHaveProperty('shell');
  });
});

describe('isCommandNotFound', () => {
  it('detects the posix ENOENT shape', () => {
    const err = Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' });
    expect(isCommandNotFound({ error: err } as never)).toBe(true);
  });

  it('detects cmd.exe reporting a missing command (status 1, no error object)', () => {
    expect(
      isCommandNotFound({
        status: 1,
        stderr: "'claude' is not recognized as an internal or external command,\r\n",
      } as never),
    ).toBe(true);
  });

  it('is false for a command that ran and failed on its own terms', () => {
    expect(isCommandNotFound({ status: 1, stderr: 'No MCP server found with name: hookmyapp' } as never)).toBe(false);
  });

  it('is false for a successful run', () => {
    expect(isCommandNotFound({ status: 0, stdout: '2.1.231' } as never)).toBe(false);
  });
});
