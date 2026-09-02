import { resolve } from 'node:path';
import type { Command } from 'commander';
import { getEffectiveApiUrl, resolveEnv } from '../config/env-profiles.js';
import { ConfigurationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { isCommandNotFound, runTool } from '../lib/spawn-tool.js';

export const MCP_NAME = 'hookmyapp';
const CLAUDE_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };

/**
 * Pin the helper to the same environment the URL was resolved against.
 *
 * The helper runs later, in its own process, with none of this invocation's
 * flags. Without `--env` it would resolve the environment afresh from the
 * persisted config, so `--env staging mcp install` wrote a staging URL beside a
 * helper that mints a production credential — which staging's /mcp then
 * rejects with a 401 (AIT-460). Emitted for every environment, production
 * included, so a later `config set env` cannot separate the two either.
 */
export function headersHelper(header?: string): string {
  const env = resolveEnv();
  const flag = header ? ` --header ${header}` : '';
  return `${shellQuote(process.execPath)} ${shellQuote(resolve(process.argv[1]))} --env ${env} mcp-headers${flag}`;
}

export function shellQuote(value: string, platform = process.platform): string {
  if (platform === 'win32') return `"${value}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function timedOut(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
}

export function mcpUrl(): string {
  return `${getEffectiveApiUrl().replace(/\/$/, '')}/mcp`;
}

/**
 * Which header carries the credential.
 *
 * `/mcp` accepts either `Authorization: Bearer <t>` or `X-API-Key: <t>`, and
 * rejects a request carrying both, so exactly one is emitted. Codex needs the
 * X-API-Key form: its `http_headers_helper` treats Authorization as reserved
 * and refuses to send it.
 */
export function headerPayload(name: string, token: string): Record<string, string> {
  return name.toLowerCase() === 'x-api-key'
    ? { 'X-API-Key': token }
    : { Authorization: `Bearer ${token}` };
}

/**
 * Deadline for the whole helper invocation.
 *
 * An MCP client spawns this command per connection attempt and cannot reap
 * what it spawned, so a helper that never exits is never cleaned up: a
 * customer ended up with 8 hung `mcp-headers` processes holding 21 GB
 * (AIT-540).
 *
 * Deliberately BELOW the 30s per-request budget rather than above it. First
 * use mints a credential over two sequential requests, so a per-request bound
 * alone allows 60s — longer than any MCP client waits, and long enough that
 * the helper is answering a question nobody is still asking. 15s covers a
 * cold handshake plus both round trips on a slow link; a genuinely
 * unreachable host fails fast and still reports its own NetworkError.
 */
const HEADERS_DEADLINE_MS = 15_000;

export async function printMcpHeaders(opts: { header?: string } = {}): Promise<void> {
  // Unref'd: it cannot hold the process open on the happy path, and it can
  // only fire when something else already is.
  const deadline = setTimeout(() => {
    process.stderr.write('Timed out resolving MCP credentials. Run: hookmyapp login\n');
    process.exit(5);
  }, HEADERS_DEADLINE_MS);
  deadline.unref();
  try {
    // NOT the session token: a WorkOS JWT carries no `aud` claim and the /mcp
    // audience guard rejects it (AIT-460). This resolves to the machine's org
    // credential, minting one on first use.
    const { getMcpAccessToken } = await import('../auth/mcp-credential.js');
    const token = await getMcpAccessToken();
    process.stdout.write(JSON.stringify(headerPayload(opts.header ?? 'authorization', token)) + '\n');
  } finally {
    clearTimeout(deadline);
  }
}

export function installClaudeMcp(): void {
  const config = JSON.stringify({
    type: 'http',
    url: mcpUrl(),
    headersHelper: headersHelper(),
  });
  const args = ['mcp', 'add-json', '--scope', 'user', MCP_NAME, config];
  let result = runTool('claude', args, CLAUDE_OPTIONS);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 && output.includes('already exists')) {
    const cleanup = removeClaudeMcp(true);
    if (!cleanup.ok) {
      throw new ConfigurationError(cleanup.detail ?? 'Claude MCP cleanup failed', 'MCP_INSTALL_FAILED');
    }
    result = runTool('claude', args, CLAUDE_OPTIONS);
  }
  if (result.error || result.status !== 0) {
    throw new ConfigurationError(
      result.error?.message || (result.stderr ?? '').trim() || 'Claude Code MCP setup failed',
      'MCP_INSTALL_FAILED',
    );
  }
}

export function removeClaudeMcp(force = false): { ok: boolean; detail?: string } {
  if (!force && process.env.NODE_ENV === 'test') return { ok: true };
  const result = runTool('claude', ['mcp', 'remove', '--scope', 'user', MCP_NAME], CLAUDE_OPTIONS);
  // Claude Code isn't installed — nothing to clean up, not a failure.
  if (isCommandNotFound(result)) return { ok: true };
  if (!result.error && result.status === 0) return { ok: true };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
  if (output.includes('not found') || output.includes('does not exist') || output.includes('no mcp server')) {
    return { ok: true };
  }
  return {
    ok: false,
    detail: timedOut(result.error)
      ? 'Claude MCP cleanup timed out'
      : result.error?.message || (result.stderr ?? '').trim() || 'Claude MCP cleanup failed',
  };
}

export function getClaudeMcpStatus(): { ok: boolean; detail: string } {
  const result = runTool('claude', ['mcp', 'get', MCP_NAME], CLAUDE_OPTIONS);
  if (timedOut(result.error)) return { ok: false, detail: 'Claude MCP check timed out' };
  if (isCommandNotFound(result)) {
    return { ok: false, detail: 'Claude Code not found' };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && output.includes('Connected')
    ? { ok: true, detail: 'connected' }
    : {
        ok: false,
        detail: 'not connected — run: hookmyapp agent setup',
      };
}

export function registerMcpCommand(program: Command): void {
  const headers = program
    .command('mcp-headers', { hidden: true })
    .option(
      '--header <name>',
      'Header carrying the credential: authorization (default) or x-api-key',
      'authorization',
    )
    .action((opts: { header?: string }) => printMcpHeaders(opts));
  addExamples(
    headers,
    '\nEXAMPLES:\n  $ hookmyapp mcp-headers\n  $ hookmyapp mcp-headers --header x-api-key\n  $ hookmyapp --env staging mcp-headers',
  );

  const mcp = program.command('mcp').description('Configure HookMyApp MCP access');
  addExamples(mcp, '\nEXAMPLES:\n  $ hookmyapp mcp install --agent claude\n  $ hookmyapp doctor');
  const install = mcp
    .command('install')
    .description('Configure Claude Code only. For every agent installed here, use: hookmyapp agent setup')
    .requiredOption('--agent <agent>', 'Agent to configure (claude)')
    .action((opts: { agent: string }) => {
      if (opts.agent !== 'claude') {
        throw new ConfigurationError(`Unsupported agent "${opts.agent}". Supported: claude. For Codex or Cursor, run: hookmyapp agent setup`, 'MCP_AGENT_UNSUPPORTED');
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
