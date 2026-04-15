import { describe, it, expect, vi, afterEach } from 'vitest';
import { cliCommandPrefix } from '../cli-self.js';

describe('cliCommandPrefix', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns "npx hookmyapp" when npm_command=exec (npx invocation)', () => {
    vi.stubEnv('npm_command', 'exec');
    expect(cliCommandPrefix()).toBe('npx hookmyapp');
  });

  it('returns "hookmyapp" when npm_command is empty (global/direct invocation)', () => {
    vi.stubEnv('npm_command', '');
    expect(cliCommandPrefix()).toBe('hookmyapp');
  });

  it('returns "hookmyapp" when npm_command=install (negative — only exec triggers npx prefix)', () => {
    vi.stubEnv('npm_command', 'install');
    expect(cliCommandPrefix()).toBe('hookmyapp');
  });
});
