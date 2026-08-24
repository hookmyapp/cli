import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

/**
 * Whether the file already declares our server as a TOML table.
 *
 * A substring search gets this wrong in both directions: `# [mcp_servers.hookmyapp]`
 * is a comment and would block a legitimate write, while `[mcp_servers.hookmyapp ]`
 * is a real, equivalent table header that would slip past and let the append
 * define the table twice — which makes the whole file unparseable for every
 * other server in it. Match the header line structurally instead. MCP_NAME is
 * a fixed identifier with no regex metacharacters.
 */
function hasServerTable(toml: string): boolean {
  const header = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${MCP_NAME}|"${MCP_NAME}"|'${MCP_NAME}')\\s*\\]`,
  );
  return toml
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && header.test(line));
}

function appendCodexServerBlock(url: string, helper: string): void {
  const path = codexConfigPath();
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (hasServerTable(before)) {
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
  // Write-then-rename rather than append. A partial append — a full disk, a
  // killed process — leaves half a table behind and makes the whole file
  // unparseable, taking every other MCP server in it down with ours. A rename
  // either happens or does not.
  writeAtomically(path, before + block, existsSync(path) ? statSync(path).mode : 0o600);
}

/**
 * Replace a config file's contents in one step.
 *
 * Both Codex's TOML and Cursor's JSON hold other people's servers and their
 * secrets, so a half-written file is worse than no change at all.
 */
function writeAtomically(path: string, contents: string, mode: number): void {
  const tmp = `${path}.hookmyapp.tmp`;
  try {
    writeFileSync(tmp, contents, { mode });
    // writeFileSync only applies `mode` when it CREATES the file; a leftover
    // tmp from an interrupted run would otherwise keep its old permissions.
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    // Windows refuses to replace a file another process holds open, where
    // posix allows it, so a running client is the likeliest cause there.
    // Either way the existing file is untouched — clean up and say so.
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new ConfigurationError(
      `Cannot write ${path}: ${(err as Error).message}. ` +
        'Your existing config is unchanged. Close the client if it is running, check you can write that file, and try again.',
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
  // With a token in it this file is a credential, so it goes owner-only
  // regardless of what the existing file allowed — an inherited 0644 under a
  // 0022 umask leaves the bearer token readable by every local account.
  // Without one there is nothing secret to protect, so the existing mode is
  // preserved rather than tightened behind the user's back.
  const mode = token ? 0o600 : existsSync(path) ? statSync(path).mode : 0o600;
  writeAtomically(path, JSON.stringify(config, null, 2) + '\n', mode);
}

/**
 * Take the stored token out of Cursor's config, leaving the entry, the URL and
 * everyone else's servers as they were.
 *
 * Claude Code and Codex resolve their credential through the CLI on every
 * request, so deleting the CLI's credentials cuts them off. Cursor holds the
 * token literally, and logout deliberately reports success when server-side
 * revocation fails — offline, say — which is exactly the case where that token
 * is still live. Leaving it on disk would mean Cursor keeps authenticating as
 * an account the user believes they logged out of.
 *
 * Best effort throughout: logout must clear local credentials even when this
 * file is missing, unreadable, or something the CLI did not write.
 */
export type CursorCleanup = 'cleared' | 'nothing' | 'failed';

export function clearCursorCredential(path = cursorConfigPath()): CursorCleanup {
  if (!existsSync(path)) return 'nothing';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // The file is THERE and we cannot see inside it, so we cannot say whether
    // a live token is in it — and Cursor, which may have read it before the
    // permissions changed, may already be holding one. Report a failure.
    return 'failed';
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    // Unparseable: not something this CLI wrote, and not something Cursor can
    // load either, so there is no live token in play to warn about.
    return 'nothing';
  }
  if (!isPlainObject(config) || !isPlainObject(config.mcpServers)) return 'nothing';
  const entry = config.mcpServers[MCP_NAME];
  if (!isPlainObject(entry) || !('headers' in entry)) return 'nothing';
  delete entry.headers;
  try {
    writeAtomically(path, JSON.stringify(config, null, 2) + '\n', statSync(path).mode);
  } catch {
    // 'failed' is NOT 'nothing': there IS a live token in that file and it is
    // still there. Logout has to say so rather than report a clean exit.
    return 'failed';
  }
  return 'cleared';
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

/**
 * Re-point the clients after the active workspace changed.
 *
 * The org credential is scoped to the workspace it was minted for, and the
 * CLI caches it. A `workspace use` that only rescoped the CLI's own session
 * left every agent talking to the PREVIOUS workspace while the CLI reported
 * the new one — silently, because the cached key still authenticates fine.
 *
 * Runs AFTER the switch is persisted. The outgoing workspace's key is revoked
 * separately, BEFORE the rescope — see the call site: once the JWT carries the
 * new org, the old workspace's key can no longer be listed or deleted.
 *
 * Dropping the cached key is enough for Claude Code and Codex: they resolve
 * their credential through the CLI on every request and mint a fresh one on
 * the next call. Cursor holds the token literally, so its entry is rewritten —
 * and only then, because minting for a machine that has no Cursor config is
 * work nobody asked for.
 *
 * Best effort: a switch that worked must not fail here.
 */
export async function repointAgentsAtActiveWorkspace(path = cursorConfigPath()): Promise<void> {
  if (!existsSync(path)) return;
  // Strip the old header BEFORE trying to mint a replacement. The revoke that
  // ran before the rescope is best effort, so the previous workspace's token
  // may still be live — and if the mint below fails, leaving it in place hands
  // Cursor working access to the workspace the user just switched away from.
  // No header is a visible failure; the wrong header is a silent one.
  clearCursorCredential(path);
  try {
    const token = await resolveMcpToken();
    if (token) configureCursor(path, token);
  } catch {
    // Offline, or a config we cannot write. `hookmyapp agent setup` fixes it.
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
