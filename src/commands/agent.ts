import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { ConfigurationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { isCommandNotFound, runTool } from '../lib/spawn-tool.js';
import { headersHelper, installClaudeMcp, mcpUrl, MCP_NAME } from './mcp.js';

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
/**
 * Codex's config lives in TOML and `codex mcp add` has no flag for a header
 * helper, so the block is written here rather than in-place-edited: remove
 * whatever is there, append a complete table at the end of the file, and let
 * `codex mcp get` — Codex's own parser — say whether it worked. Appending a
 * whole table cannot corrupt the tables above it, which matters because this
 * file also holds the user's other MCP servers and their secrets.
 *
 * The helper emits X-API-Key, not Authorization: Codex treats Authorization as
 * reserved in `http_headers_helper` and refuses to send it. `/mcp` accepts
 * either header (mcp-auth.guard.ts) and rejects both together, so exactly one
 * goes out.
 */
function configureCodex(): void {
  const url = mcpUrl();
  const helper = headersHelper('x-api-key');
  const existing = codexEntry();
  // Both halves must match: a stale entry may carry the right URL from before
  // this change and still have no credential at all.
  if (existing?.includes(url) && existing.includes('http_headers_helper: <redacted>')) return;
  if (existing) runTool('codex', ['mcp', 'remove', MCP_NAME], TOOL_OPTIONS);

  appendCodexServerBlock(url, helper);

  const written = codexEntry();
  if (!written?.includes(url) || !written.includes('http_headers_helper')) {
    throw new ConfigurationError(
      `Codex MCP setup failed — check ${codexConfigPath()} for an [mcp_servers.${MCP_NAME}] block`,
      'MCP_INSTALL_FAILED',
    );
  }
}

function codexConfigPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
}

/** TOML basic strings take backslash escapes, so both must be escaped. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function appendCodexServerBlock(url: string, helper: string): void {
  const path = codexConfigPath();
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (before.includes(`[mcp_servers.${MCP_NAME}]`)) {
    // `codex mcp remove` did not take. Appending now would define the table
    // twice, which makes the whole file unparseable for every other server.
    throw new ConfigurationError(
      `Codex still has an [mcp_servers.${MCP_NAME}] block in ${path} — remove it and re-run`,
      'MCP_INSTALL_FAILED',
    );
  }
  const separator = before.length === 0 || before.endsWith('\n') ? '' : '\n';
  const block =
    `${separator}\n[mcp_servers.${MCP_NAME}]\n` +
    `url = ${tomlString(url)}\n` +
    `http_headers_helper = ${tomlString(helper)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    appendFileSync(path, block);
  } catch (err) {
    throw new ConfigurationError(
      `Cannot write ${path}: ${(err as Error).message}`,
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
/**
 * Cursor takes a static `headers` map and has no helper mechanism, so unlike
 * Claude Code and Codex — which invoke the CLI per request — the token itself
 * lands in this file. That is the same trade every other MCP server on the
 * page makes, and the key is per-machine and revocable, so a leaked config
 * costs one `hookmyapp credentials revoke` rather than the account.
 *
 * `token` is optional: without a session there is nothing to write, and a URL
 * alone still beats no entry.
 */
export function configureCursor(path = cursorConfigPath(), token?: string): void {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new ConfigurationError(`Cannot read ${path}: ${(err as Error).message}`, 'MCP_INSTALL_FAILED');
    }
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ConfigurationError(
          `${path} is not valid JSON — fix it first so this does not overwrite your other MCP servers`,
          'MCP_INSTALL_FAILED',
        );
      }
      // Valid JSON is not necessarily a config: `null` and primitives throw on
      // property access, and an array silently accepts `mcpServers` in memory
      // while JSON.stringify drops it — reporting success without configuring
      // anything. Refuse both rather than guess what the file meant.
      if (!isPlainObject(parsed)) {
        throw new ConfigurationError(
          `${path} does not contain a JSON object — fix it first so this does not overwrite your other MCP servers`,
          'MCP_INSTALL_FAILED',
        );
      }
      config = parsed;
    }
  }
  if ('mcpServers' in config && !isPlainObject(config.mcpServers)) {
    throw new ConfigurationError(
      `${path} has an mcpServers value that is not a JSON object — fix it first so this does not discard your other MCP servers`,
      'MCP_INSTALL_FAILED',
    );
  }
  const servers = isPlainObject(config.mcpServers) ? config.mcpServers : {};
  const entry: Record<string, unknown> = { url: mcpUrl() };
  if (token) entry.headers = { Authorization: `Bearer ${token}` };
  config.mcpServers = { ...servers, [MCP_NAME]: entry };

  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so an interrupted run cannot leave a half-written config
  // where Cursor's other servers used to be.
  const tmp = `${path}.hookmyapp.tmp`;
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode });
    renameSync(tmp, path);
  } catch (err) {
    // Windows refuses to replace a file another process holds open, where posix
    // allows it, so a running Cursor is the likeliest cause there. Either way
    // the existing config is untouched — clean up the temp file and say so.
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new ConfigurationError(
      `Cannot write ${path}: ${(err as Error).message}. ` +
        'Your existing config is unchanged. Close Cursor if it is running, check you can write that file, and try again.',
      'MCP_INSTALL_FAILED',
    );
  }
}

function configure(client: ClientId, token?: string): void {
  if (client === 'claude') return installClaudeMcp();
  if (client === 'codex') return configureCodex();
  return configureCursor(cursorConfigPath(), token);
}

/**
 * Every client loads its MCP servers at startup, so a session that is already
 * running keeps talking to whatever was configured when it launched. Observed
 * live: Codex answered a tool call from the PREVIOUS server and reported it as
 * proof the new one worked. Each note therefore names the restart.
 */
function postSetupNote(client: ClientId, token?: string): string | undefined {
  // No client is told to sign in any more — the credential travels with the
  // config. Cursor is the one that cannot get one without a session, because
  // its entry has to carry the token literally.
  if (client === 'cursor' && !token) {
    return 'restart Cursor — run `hookmyapp login`, then `hookmyapp agent setup` to give it access';
  }
  if (client === 'cursor') return 'restart Cursor';
  if (client === 'codex') return 'restart Codex';
  return 'tools activate in your next session';
}

export function configureClients(clients: ClientId[], token?: string): ClientResult[] {
  return clients.map((client) => {
    try {
      configure(client, token);
      return { client, status: 'configured' as const, detail: postSetupNote(client, token) };
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

// A function, not a const: `--env` is applied while the command runs, so a URL
// baked in at import time would name the wrong environment.
function noClientText(): string {
  return (
    `No supported agent found (${CLIENTS.map((c) => LABELS[c]).join(', ')}).\n` +
    `Add the HookMyApp MCP server to your agent manually: ${mcpUrl()}\n`
  );
}

/**
 * The credential the clients are configured with, resolved once per run.
 *
 * Minting happens HERE — during login or an explicit `agent setup` — rather
 * than lazily inside a request helper, so it is a visible step of something the
 * user ran, and a failure surfaces against that command instead of inside an
 * agent's next tool call.
 *
 * Soft failure: not logged in, offline, or a mint the server refused all mean
 * the same thing here — configure the URL anyway. Claude Code and Codex resolve
 * their credential per request and will pick one up later; only Cursor, which
 * needs the token written in, is left needing a re-run.
 */
async function resolveMcpToken(): Promise<string | undefined> {
  try {
    const { getMcpAccessToken } = await import('../auth/mcp-credential.js');
    return await getMcpAccessToken();
  } catch {
    return undefined;
  }
}

export async function runAgentSetup(opts: {
  client?: string;
  skills?: boolean;
  json?: boolean;
}): Promise<void> {
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

  const clients = configureClients(targets, await resolveMcpToken());
  const skills = opts.skills === false ? null : installSkills();

  // Report every client before failing, so one broken agent does not hide the
  // others — but a script or agent reading only the exit status must still see
  // that something did not get configured. Skills are best-effort by design and
  // deliberately do not fail the command.
  if (clients.some((c) => c.status === 'failed')) process.exitCode = 1;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ clients, skills }) + '\n');
    return;
  }
  if (clients.length === 0) process.stdout.write(noClientText());
  process.stdout.write(renderText(clients, skills));
}

/**
 * Called after login. Configures MCP for whatever is installed — never skills,
 * because a sign-in has no business running an npm install. Best-effort: a
 * failure here is reported and never fails the login that succeeded.
 */
export async function maybeSetupAgents(force = false): Promise<void> {
  if (!force && process.env.NODE_ENV === 'test') return;
  const detected = detectClients();
  if (detected.length === 0) {
    // Only worth saying to a human at a terminal — a CI or server login has no
    // agent to configure and does not want the pointer.
    if (process.stdout.isTTY) process.stderr.write(noClientText());
    return;
  }
  for (const r of configureClients(detected, await resolveMcpToken())) {
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
    .action(async (opts: { client?: string; skills?: boolean }) => {
      await runAgentSetup({ ...opts, json: Boolean(program.opts().json) });
    });
  addExamples(
    setup,
    '\nEXAMPLES:\n  $ hookmyapp agent setup\n  $ hookmyapp agent setup --client codex\n  $ hookmyapp agent setup --no-skills',
  );
}
