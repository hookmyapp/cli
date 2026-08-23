import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { ConfigurationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { isCommandNotFound, runTool } from '../lib/spawn-tool.js';
import { installClaudeMcp, mcpUrl, MCP_NAME } from './mcp.js';

const TOOL_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };
// `npx skills add` may download the package first, so it gets its own budget.
const SKILLS_OPTIONS = { encoding: 'utf8' as const, timeout: 180_000 };

export const CLIENTS = ['claude', 'codex', 'cursor'] as const;
export type ClientId = (typeof CLIENTS)[number];

const LABELS: Record<ClientId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export type ClientResult = { client: ClientId; status: 'configured' | 'failed'; detail?: string };
export type SkillsResult = { status: 'installed' | 'skipped' | 'failed'; detail?: string };

function cursorConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

/**
 * Detection is per-client because the three ship differently: Claude Code and
 * Codex are CLIs on PATH, Cursor is a GUI app whose binary usually is not, so
 * only its config directory proves it is installed.
 */
export function detectClients(cursorDir = dirname(cursorConfigPath())): ClientId[] {
  const found: ClientId[] = [];
  for (const bin of ['claude', 'codex'] as const) {
    const probe = runTool(bin, ['--version'], TOOL_OPTIONS);
    if (!probe.error && probe.status === 0) found.push(bin);
  }
  if (existsSync(cursorDir)) found.push('cursor');
  return found;
}

/** Reads back what Codex has stored for a server name, or null if it has none. */
function codexEntry(): string | null {
  const result = runTool('codex', ['mcp', 'get', MCP_NAME], TOOL_OPTIONS);
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/**
 * `codex mcp add` writes the entry within a second or two and then never
 * exits (codex-cli 0.147.0), so its exit status is worthless here — the
 * timeout always fires. Read the config back with `codex mcp get`, which is
 * instant, and let that decide whether the setup worked.
 */
function configureCodex(): void {
  const url = mcpUrl();
  const existing = codexEntry();
  if (existing?.includes(url)) return;
  // A stale entry points at another environment's URL; `add` will not replace it.
  if (existing) runTool('codex', ['mcp', 'remove', MCP_NAME], TOOL_OPTIONS);

  runTool('codex', ['mcp', 'add', MCP_NAME, '--url', url], TOOL_OPTIONS);

  if (!codexEntry()?.includes(url)) {
    throw new ConfigurationError(
      `Codex MCP setup failed — run: codex mcp add ${MCP_NAME} --url ${url}`,
      'MCP_INSTALL_FAILED',
    );
  }
}

/**
 * Cursor has no CLI that can add an MCP server, so this edits its config file
 * directly. That file holds other people's servers and their secrets: only the
 * `hookmyapp` key is ever touched, and unreadable/unparseable JSON aborts
 * rather than being replaced with a fresh object.
 */
export function configureCursor(path = cursorConfigPath()): void {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new ConfigurationError(`Cannot read ${path}: ${(err as Error).message}`, 'MCP_INSTALL_FAILED');
    }
    if (raw.trim().length > 0) {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new ConfigurationError(
          `${path} is not valid JSON — fix it first so this does not overwrite your other MCP servers`,
          'MCP_INSTALL_FAILED',
        );
      }
    }
  }
  const servers =
    typeof config.mcpServers === 'object' && config.mcpServers !== null
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  config.mcpServers = { ...servers, [MCP_NAME]: { url: mcpUrl() } };

  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so an interrupted run cannot leave a half-written config
  // where Cursor's other servers used to be.
  const tmp = `${path}.hookmyapp.tmp`;
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode });
  renameSync(tmp, path);
}

function configure(client: ClientId): void {
  if (client === 'claude') return installClaudeMcp();
  if (client === 'codex') return configureCodex();
  return configureCursor();
}

/**
 * Every client loads its MCP servers at startup, so a session that is already
 * running keeps talking to whatever was configured when it launched. Observed
 * live: Codex answered a tool call from the PREVIOUS server and reported it as
 * proof the new one worked. Each note therefore names the restart.
 */
function postSetupNote(client: ClientId): string | undefined {
  if (client === 'codex') return `run: codex mcp login ${MCP_NAME}, then restart Codex`;
  if (client === 'cursor') return 'restart Cursor, then sign in from its MCP settings';
  return 'tools activate in your next session';
}

export function configureClients(clients: ClientId[]): ClientResult[] {
  return clients.map((client) => {
    try {
      configure(client);
      return { client, status: 'configured' as const, detail: postSetupNote(client) };
    } catch (err) {
      return { client, status: 'failed' as const, detail: (err as Error).message };
    }
  });
}

export function installSkills(): SkillsResult {
  const result = runTool(
    'npx',
    ['-y', 'skills', 'add', 'hookmyapp/agent-skills', '--all', '--global'],
    SKILLS_OPTIONS,
  );
  if (isCommandNotFound(result)) {
    return { status: 'skipped', detail: 'npx not found — install Node.js 20+, then re-run' };
  }
  if (result.error || result.status !== 0) {
    return {
      status: 'failed',
      detail: (result.stderr ?? '').trim().split('\n').pop() || 'skills install failed',
    };
  }
  return { status: 'installed' };
}

function renderText(clients: ClientResult[], skills: SkillsResult | null): string {
  const lines: string[] = [];
  for (const r of clients) {
    const suffix = r.detail ? ` — ${r.detail}` : '';
    lines.push(`${LABELS[r.client].padEnd(13)}${r.status}${suffix}`);
  }
  if (skills) lines.push(`${'Agent skills'.padEnd(13)}${skills.status}${skills.detail ? ` — ${skills.detail}` : ''}`);
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

const NO_CLIENT_TEXT =
  `No supported agent found (${CLIENTS.map((c) => LABELS[c]).join(', ')}).\n` +
  `Add the HookMyApp MCP server to your agent manually: ${mcpUrl()}\n`;

export function runAgentSetup(opts: { client?: string; skills?: boolean; json?: boolean }): void {
  let targets: ClientId[];
  if (opts.client) {
    if (!(CLIENTS as readonly string[]).includes(opts.client)) {
      throw new ConfigurationError(
        `Unsupported client "${opts.client}". Supported: ${CLIENTS.join(', ')}`,
        'MCP_AGENT_UNSUPPORTED',
      );
    }
    targets = [opts.client as ClientId];
  } else {
    targets = detectClients();
  }

  const clients = configureClients(targets);
  const skills = opts.skills === false ? null : installSkills();

  if (opts.json) {
    process.stdout.write(JSON.stringify({ clients, skills }) + '\n');
    return;
  }
  if (clients.length === 0) process.stdout.write(NO_CLIENT_TEXT);
  process.stdout.write(renderText(clients, skills));
}

/**
 * Called after login. Configures MCP for whatever is installed — never skills,
 * because a sign-in has no business running an npm install. Best-effort: a
 * failure here is reported and never fails the login that succeeded.
 */
export function maybeSetupAgents(force = false): void {
  if (!force && process.env.NODE_ENV === 'test') return;
  const detected = detectClients();
  if (detected.length === 0) {
    // Only worth saying to a human at a terminal — a CI or server login has no
    // agent to configure and does not want the pointer.
    if (process.stdout.isTTY) process.stderr.write(NO_CLIENT_TEXT);
    return;
  }
  for (const r of configureClients(detected)) {
    if (r.status === 'failed') {
      process.stderr.write(
        `HookMyApp login succeeded, but ${LABELS[r.client]} MCP setup failed: ${r.detail}\n` +
          `Run: hookmyapp agent setup --client ${r.client}\n`,
      );
    } else {
      // stderr, not stdout: this runs inside `login`, and `login --json` is the
      // documented agent path — a progress line on stdout lands in front of the
      // JSON envelope and breaks every parser reading it.
      process.stderr.write(`HookMyApp MCP configured for ${LABELS[r.client]}${r.detail ? ` — ${r.detail}` : ''}\n`);
    }
  }
}

export function registerAgentCommand(program: Command): void {
  const agent = program.command('agent').description('Configure coding agents to use HookMyApp');
  addExamples(agent, '\nEXAMPLES:\n  $ hookmyapp agent setup\n  $ hookmyapp agent setup --client cursor');
  const setup = agent
    .command('setup')
    .description('Set up the HookMyApp MCP server and agent skills in every agent installed here')
    .option('--client <client>', `Configure only this client (${CLIENTS.join(', ')})`)
    .option('--no-skills', 'Skip installing the HookMyApp agent skills')
    .action((opts: { client?: string; skills?: boolean }) => {
      runAgentSetup({ ...opts, json: Boolean(program.opts().json) });
    });
  addExamples(
    setup,
    '\nEXAMPLES:\n  $ hookmyapp agent setup\n  $ hookmyapp agent setup --client codex\n  $ hookmyapp agent setup --no-skills',
  );
}
