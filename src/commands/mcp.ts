import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { getEffectiveApiUrl } from '../config/env-profiles.js';
import { ConfigurationError } from '../output/error.js';
import { addExamples } from '../output/help.js';

const MCP_NAME = 'hookmyapp';
const CLAUDE_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };

function headersHelper(): string {
  return `${shellQuote(process.execPath)} ${shellQuote(resolve(process.argv[1]))} mcp-headers`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function timedOut(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
}

function mcpUrl(): string {
  return `${getEffectiveApiUrl().replace(/\/$/, '')}/mcp`;
}

export async function printMcpHeaders(): Promise<void> {
  const { getValidAccessToken } = await import('../api/client.js');
  const token = await getValidAccessToken();
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${token}` }) + '\n');
}

export function installClaudeMcp(): void {
  const config = JSON.stringify({
    type: 'http',
    url: mcpUrl(),
    headersHelper: headersHelper(),
  });
  const args = ['mcp', 'add-json', '--scope', 'user', MCP_NAME, config];
  let result = spawnSync('claude', args, CLAUDE_OPTIONS);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 && output.includes('already exists')) {
    const cleanup = removeClaudeMcp(true);
    if (!cleanup.ok) {
      throw new ConfigurationError(cleanup.detail ?? 'Claude MCP cleanup failed', 'MCP_INSTALL_FAILED');
    }
    result = spawnSync('claude', args, CLAUDE_OPTIONS);
  }
  if (result.error || result.status !== 0) {
    throw new ConfigurationError(
      result.error?.message || (result.stderr ?? '').trim() || 'Claude Code MCP setup failed',
      'MCP_INSTALL_FAILED',
    );
  }
}

export function maybeInstallClaudeMcp(force = false): void {
  if (!force && process.env.NODE_ENV === 'test') return;
  const probe = spawnSync('claude', ['--version'], CLAUDE_OPTIONS);
  if (probe.error || probe.status !== 0) return;
  try {
    installClaudeMcp();
  } catch (err) {
    process.stderr.write(
      `HookMyApp login succeeded, but Claude MCP setup failed: ${(err as Error).message}\n` +
        'Run: hookmyapp mcp install --agent claude\n',
    );
  }
}

export function removeClaudeMcp(force = false): { ok: boolean; detail?: string } {
  if (!force && process.env.NODE_ENV === 'test') return { ok: true };
  const result = spawnSync('claude', ['mcp', 'remove', '--scope', 'user', MCP_NAME], CLAUDE_OPTIONS);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { ok: true };
  if (!result.error && result.status === 0) return { ok: true };
  return {
    ok: false,
    detail: timedOut(result.error)
      ? 'Claude MCP cleanup timed out'
      : result.error?.message || (result.stderr ?? '').trim() || 'Claude MCP cleanup failed',
  };
}

export function getClaudeMcpStatus(): { ok: boolean; detail: string } {
  const result = spawnSync('claude', ['mcp', 'get', MCP_NAME], CLAUDE_OPTIONS);
  if (timedOut(result.error)) return { ok: false, detail: 'Claude MCP check timed out' };
  if (result.error?.message.includes('ENOENT')) {
    return { ok: false, detail: 'Claude Code not found' };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && output.includes('Connected')
    ? { ok: true, detail: 'connected' }
    : {
        ok: false,
        detail: 'not connected — run: hookmyapp mcp install --agent claude',
      };
}

export function registerMcpCommand(program: Command): void {
  const headers = program.command('mcp-headers', { hidden: true }).action(printMcpHeaders);
  addExamples(headers, '\nEXAMPLES:\n  $ hookmyapp mcp-headers\n  $ hookmyapp --env staging mcp-headers');

  const mcp = program.command('mcp').description('Configure HookMyApp MCP access');
  addExamples(mcp, '\nEXAMPLES:\n  $ hookmyapp mcp install --agent claude\n  $ hookmyapp doctor');
  const install = mcp
    .command('install')
    .requiredOption('--agent <agent>', 'Agent to configure (claude)')
    .action((opts: { agent: string }) => {
      if (opts.agent !== 'claude') {
        throw new ConfigurationError(`Unsupported agent "${opts.agent}". Supported: claude`, 'MCP_AGENT_UNSUPPORTED');
      }
      installClaudeMcp();
      process.stdout.write(
        program.opts().json
          ? JSON.stringify({ status: 'configured', agent: 'claude' }) + '\n'
          : 'HookMyApp MCP configured for Claude Code.\n',
      );
    });
  addExamples(
    install,
    '\nEXAMPLES:\n  $ hookmyapp mcp install --agent claude\n  $ hookmyapp --env staging mcp install --agent claude',
  );
}
