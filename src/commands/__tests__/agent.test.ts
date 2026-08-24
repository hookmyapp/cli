import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { runTool } from '../../lib/spawn-tool.js';

vi.mock('../../lib/spawn-tool.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/spawn-tool.js')>()),
  runTool: vi.fn(),
}));
vi.mock('../../config/env-profiles.js', () => ({
  getEffectiveApiUrl: () => 'https://api.hookmyapp.com',
  resolveEnv: () => 'production',
}));
const getMcpAccessTokenMock = vi.hoisted(() => vi.fn(async () => 'hmok_new_ws'));
vi.mock('../../auth/mcp-credential.js', () => ({
  getMcpAccessToken: getMcpAccessTokenMock,
  revokePreviousMcpCredential: vi.fn(async () => undefined),
}));

import {
  clearCursorCredential,
  configureCursor,
  repointAgentsAtActiveWorkspace,
  detectClients,
  installSkills,
  maybeSetupAgents,
  registerAgentCommand,
  runAgentSetup,
} from '../agent.js';

const ok = { status: 0 } as never;
const enoent = { status: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } as never;

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'hookmyapp-agent-')), name);
}

describe('agent setup', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Codex configuration is a real file write now, so every test gets its own
    // CODEX_HOME rather than editing the developer's actual Codex config.
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'hookmyapp-codex-'));
  });

  afterEach(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  test('detects only the CLIs that answer --version', () => {
    // claude present, codex absent. Cursor is filesystem-detected, so a
    // machine with ~/.cursor reports it either way — assert on the CLIs.
    vi.mocked(runTool).mockReturnValueOnce(ok).mockReturnValueOnce(enoent);

    const found = detectClients();

    expect(found).toContain('claude');
    expect(found).not.toContain('codex');
  });

  // `codex mcp get` is now only the read-back check: the block itself is
  // written by us, because `codex mcp add` has no flag for a header helper.
  const codexHas = (url: string, withHelper = true) =>
    ({
      status: 0,
      stdout: `url: ${url}\n${withHelper ? 'http_headers_helper: <redacted>' : 'http_headers_helper: -'}`,
    }) as never;
  const codexMissing = { status: 1, stderr: 'No MCP server' } as never;
  const codexConfig = () => join(process.env.CODEX_HOME!, 'config.toml');

  test('finds nothing when no agent is installed', () => {
    vi.mocked(runTool).mockReturnValue(enoent);

    expect(detectClients(join(tmpdir(), 'hookmyapp-no-such-cursor-dir'))).toEqual([]);
  });

  test('gives Codex the credential instead of another sign-in', async () => {
    vi.mocked(runTool)
      .mockReturnValueOnce(codexMissing) // get: nothing configured yet
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp')); // get: verify

    await runAgentSetup({ client: 'codex', skills: false, json: false });

    const toml = readFileSync(codexConfig(), 'utf8');
    expect(toml).toContain('[mcp_servers.hookmyapp]');
    expect(toml).toContain('url = "https://api.hookmyapp.com/mcp"');
    // X-API-Key, not Authorization: Codex treats Authorization as reserved in
    // http_headers_helper and refuses to send it.
    expect(toml).toMatch(/http_headers_helper = ".*mcp-headers --header x-api-key"/);
  });

  test('never writes the token itself into the Codex config', async () => {
    // The helper is invoked per request, so nothing secret lands on disk here.
    vi.mocked(runTool)
      .mockReturnValueOnce(codexMissing)
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    await runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(readFileSync(codexConfig(), 'utf8')).not.toContain('hmok_');
  });

  test('leaves the other MCP servers in the Codex config alone', async () => {
    writeFileSync(codexConfig(), '[mcp_servers.someone_else]\nurl = "https://other.example/mcp"\n');
    vi.mocked(runTool)
      .mockReturnValueOnce(codexMissing)
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    await runAgentSetup({ client: 'codex', skills: false, json: false });

    const toml = readFileSync(codexConfig(), 'utf8');
    expect(toml).toContain('[mcp_servers.someone_else]');
    expect(toml).toContain('[mcp_servers.hookmyapp]');
  });

  test('refuses to append a second hookmyapp table when removal did not take', async () => {
    // Two tables of the same name make the whole file unparseable — which
    // would take every other server in it down, not just ours.
    writeFileSync(codexConfig(), '[mcp_servers.hookmyapp]\nurl = "https://stale.example/mcp"\n');
    vi.mocked(runTool)
      .mockReturnValueOnce(codexHas('https://stale.example/mcp', false)) // get
      .mockReturnValueOnce({ status: 0 } as never); // remove (no-op)

    await runAgentSetup({ client: 'codex', skills: false, json: true });

    expect(readFileSync(codexConfig(), 'utf8')).not.toMatch(/hookmyapp[\s\S]*hookmyapp/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test('is not fooled by a commented-out hookmyapp table', async () => {
    // A substring search calls this an existing table and refuses to write,
    // leaving Codex permanently unconfigured on any machine whose config
    // happens to carry the block as a comment.
    writeFileSync(
      codexConfig(),
      '# [mcp_servers.hookmyapp]\n[mcp_servers.someone_else]\nurl = "https://other.example/mcp"\n',
    );
    vi.mocked(runTool)
      .mockReturnValueOnce(codexMissing)
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    await runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(readFileSync(codexConfig(), 'utf8')).toContain('url = "https://api.hookmyapp.com/mcp"');
  });

  test('refuses to append beside a table header written with inner spaces', async () => {
    // `[mcp_servers.hookmyapp ]` is the same table to a TOML parser. A
    // substring search misses it, and the append then defines the table twice
    // — which takes every other server in the file down with it.
    writeFileSync(codexConfig(), '[mcp_servers.hookmyapp ]\nurl = "https://stale.example/mcp"\n');
    vi.mocked(runTool)
      .mockReturnValueOnce(codexHas('https://stale.example/mcp', false)) // get
      .mockReturnValueOnce({ status: 0 } as never); // remove (no-op)

    await runAgentSetup({ client: 'codex', skills: false, json: true });

    expect(readFileSync(codexConfig(), 'utf8')).not.toMatch(/hookmyapp[\s\S]*hookmyapp/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test('re-configures a Codex entry that has a URL but no credential', async () => {
    // Entries written before this change carry the URL and nothing else, so a
    // URL match alone must not count as already set up.
    vi.mocked(runTool)
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp', false))
      .mockReturnValueOnce({ status: 0 } as never) // remove
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    await runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(readFileSync(codexConfig(), 'utf8')).toContain('http_headers_helper');
  });

  test('leaves a fully configured Codex entry alone', async () => {
    vi.mocked(runTool).mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    await runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(runTool).toHaveBeenCalledOnce();
    expect(existsSync(codexConfig())).toBe(false);
  });

  test('keeps every other Cursor MCP server when adding ours', () => {
    const path = tmpFile('mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, other: 1 }));

    configureCursor(path);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: {
        github: { command: 'gh-mcp' },
        hookmyapp: { url: 'https://api.hookmyapp.com/mcp' },
      },
      other: 1,
    });
  });

  test('refuses to overwrite an unparseable Cursor config', () => {
    const path = tmpFile('mcp.json');
    writeFileSync(path, '{ "mcpServers": { broken');

    expect(() => configureCursor(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{ "mcpServers": { broken');
  });

  test('creates a Cursor config when there is none', () => {
    const path = tmpFile('mcp.json');

    configureCursor(path);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { hookmyapp: { url: 'https://api.hookmyapp.com/mcp' } },
    });
  });

  // POSIX only: chmod cannot express owner-only on Windows, where the mode
  // reads back 0o666. Same platform limit credentials.json already lives with.
  test.skipIf(process.platform === 'win32')('stores the Cursor token owner-only', () => {
    // Cursor has no helper mechanism, so the bearer token is written into this
    // file. Inheriting an existing 0644 under a 0022 umask would leave it
    // readable by every other local account.
    const path = tmpFile('mcp.json');
    writeFileSync(path, '{"mcpServers":{}}', { mode: 0o644 });
    chmodSync(path, 0o644);

    configureCursor(path, 'hmok_secret');

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === 'win32')('leaves the mode alone when there is no token to protect', () => {
    // Nothing secret goes in, so tightening the file behind the user's back
    // would be a change they did not ask for.
    const path = tmpFile('mcp.json');
    writeFileSync(path, '{"mcpServers":{}}');
    chmodSync(path, 0o644);

    configureCursor(path);

    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  // POSIX only: chmod on a DIRECTORY is a no-op on Windows, so the read-only
  // trick cannot build the failure there and the write simply succeeds. The
  // guard under test is platform-independent — it is the Windows-only CAUSE
  // (a running Cursor holding the file open) that cannot be simulated in CI
  // without a second process, which is not worth a test harness.
  test.skipIf(process.platform === 'win32')('leaves no temp file and says the config is intact when it cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hookmyapp-agent-'));
    const path = join(dir, 'mcp.json');
    writeFileSync(path, '{"mcpServers":{}}');
    chmodSync(dir, 0o500);

    try {
      expect(() => configureCursor(path)).toThrow(/existing config is unchanged/);
      expect(existsSync(`${path}.hookmyapp.tmp`)).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test('logout strips our stored token and nobody else\'s', () => {
    const path = tmpFile('mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          hookmyapp: { url: 'https://api.hookmyapp.com/mcp', headers: { Authorization: 'Bearer hmok_live' } },
          someone_else: { url: 'https://other.example/mcp', headers: { Authorization: 'Bearer theirs' } },
        },
      }),
    );

    expect(clearCursorCredential(path)).toBe('cleared');

    const after = JSON.parse(readFileSync(path, 'utf8'));
    // Entry and URL stay, so the next login fills the header back in.
    expect(after.mcpServers.hookmyapp).toEqual({ url: 'https://api.hookmyapp.com/mcp' });
    expect(after.mcpServers.someone_else.headers.Authorization).toBe('Bearer theirs');
  });

  // POSIX only: an unreadable file cannot be built on Windows this way.
  test.skipIf(process.platform === 'win32')('logout reports a Cursor config it cannot even read', () => {
    // The file is there and we cannot see inside it, so we cannot say whether
    // a live token is in it — and Cursor may already have loaded one. That is
    // a warning, not a clean logout.
    const path = tmpFile('mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    chmodSync(path, 0o000);

    try {
      expect(clearCursorCredential(path)).toBe('failed');
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test('logout leaves an unrelated Cursor config alone', () => {
    // Best effort: logout must clear local credentials even when this file is
    // missing, not JSON, or something the CLI never wrote.
    const missing = tmpFile('mcp.json');
    expect(clearCursorCredential(missing)).toBe('nothing');

    const junk = tmpFile('mcp.json');
    writeFileSync(junk, '{ not json');
    expect(clearCursorCredential(junk)).toBe('nothing');
    expect(readFileSync(junk, 'utf8')).toBe('{ not json');
  });

  test('refuses a Cursor config whose root is not an object', () => {
    // An array is valid JSON and accepts the property in memory, but
    // JSON.stringify drops it — success would be reported with nothing written.
    const path = tmpFile('mcp.json');
    writeFileSync(path, '[]');

    expect(() => configureCursor(path)).toThrow(/does not contain a JSON object/);
    expect(readFileSync(path, 'utf8')).toBe('[]');
  });

  test('refuses to discard an mcpServers value it does not understand', () => {
    const path = tmpFile('mcp.json');
    writeFileSync(path, '{"mcpServers":"nonsense"}');

    expect(() => configureCursor(path)).toThrow(/not a JSON object/);
    expect(readFileSync(path, 'utf8')).toBe('{"mcpServers":"nonsense"}');
  });

  test('exits non-zero when a client could not be configured', async () => {
    vi.mocked(runTool).mockReturnValue(codexMissing);
    const before = process.exitCode;

    await runAgentSetup({ client: 'codex', skills: false, json: true });

    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });

  test('reports a failed client instead of aborting the run', async () => {
    vi.mocked(runTool).mockReturnValue(codexMissing);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runAgentSetup({ client: 'codex', skills: false, json: true });

    const parsed = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(parsed.skills).toBeNull();
    expect(parsed.clients[0]).toMatchObject({ client: 'codex', status: 'failed' });
    expect(parsed.clients[0].detail).toContain('config.toml');
  });

  test('keeps login progress off stdout so --json stays parseable', async () => {
    vi.mocked(runTool).mockReturnValue(ok);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await maybeSetupAgents(true);

    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain('HookMyApp MCP configured for');
  });

  test('tells every client it needs a restart before the new server is live', async () => {
    vi.mocked(runTool).mockReturnValue(codexHas('https://api.hookmyapp.com/mcp'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runAgentSetup({ client: 'codex', skills: false, json: true });

    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0])).clients[0].detail).toContain('restart Codex');
  });

  test('gives Cursor the credential, since it has no helper mechanism', async () => {
    const path = tmpFile('mcp.json');

    configureCursor(path, 'hmok_live');

    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.hookmyapp).toEqual({
      url: 'https://api.hookmyapp.com/mcp',
      headers: { Authorization: 'Bearer hmok_live' },
    });
  });

  test('writes a Cursor entry without headers when there is no session', async () => {
    // A URL alone still beats no entry; the note tells them to log in.
    const path = tmpFile('mcp.json');

    configureCursor(path);

    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.hookmyapp).toEqual({
      url: 'https://api.hookmyapp.com/mcp',
    });
  });

  test('never tells a configured client to go and sign in again', async () => {
    // The whole point: one login, every tool. A second sign-in prompt here
    // means the credential did not reach that client.
    vi.mocked(runTool).mockReturnValue(codexHas('https://api.hookmyapp.com/mcp'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runAgentSetup({ client: 'codex', skills: false, json: true });

    const detail = JSON.parse(String(write.mock.calls.at(-1)?.[0])).clients[0].detail;
    expect(detail).not.toMatch(/sign in|mcp login/i);
    expect(detail).toContain('restart');
  });

  test('a workspace switch gives Cursor a key for the new workspace', async () => {
    const path = tmpFile('mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { hookmyapp: { url: 'https://api.hookmyapp.com/mcp', headers: { Authorization: 'Bearer hmok_old_ws' } } },
      }),
    );
    getMcpAccessTokenMock.mockResolvedValueOnce('hmok_new_ws');

    await repointAgentsAtActiveWorkspace(path);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers.hookmyapp.headers.Authorization).toBe('Bearer hmok_new_ws');
  });

  test('a failed re-mint leaves no token rather than the old workspace\'s', async () => {
    // The revoke before the rescope is best effort, so the old token may still
    // be live. Keeping it would hand Cursor working access to the workspace
    // the user just switched away from — a silent failure. No header is a
    // visible one, and `hookmyapp agent setup` fixes it.
    const path = tmpFile('mcp.json');
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { hookmyapp: { url: 'https://api.hookmyapp.com/mcp', headers: { Authorization: 'Bearer hmok_old_ws' } } },
      }),
    );

    getMcpAccessTokenMock.mockRejectedValueOnce(new Error('offline'));

    await repointAgentsAtActiveWorkspace(path);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.mcpServers.hookmyapp).toEqual({ url: 'https://api.hookmyapp.com/mcp' });
  });

  test('rejects an unknown client', async () => {
    await expect(runAgentSetup({ client: 'windsurf', skills: false, json: false })).rejects.toThrow(/Unsupported client/);
  });

  test('treats a missing npx as skipped, not failed', () => {
    vi.mocked(runTool).mockReturnValue(enoent);

    expect(installSkills()).toEqual({
      status: 'skipped',
      detail: 'npx not found — install Node.js 20+, then re-run',
    });
  });

  test('installs skills by default and skips them with --no-skills', async () => {
    // Codex, not Cursor: Cursor is configured through the real filesystem at
    // the default path, so driving it from here would rewrite the developer's
    // own ~/.cursor/mcp.json. Every Codex call goes through the mocked runTool.
    vi.mocked(runTool).mockReturnValue(codexHas('https://api.hookmyapp.com/mcp'));
    const program = new Command().option('--json');
    registerAgentCommand(program);
    const npxCalls = (): unknown[][] => vi.mocked(runTool).mock.calls.filter((c) => c[0] === 'npx');

    await program.parseAsync(['node', 'hookmyapp', 'agent', 'setup', '--client', 'codex', '--no-skills']);
    expect(npxCalls()).toHaveLength(0);

    await program.parseAsync(['node', 'hookmyapp', 'agent', 'setup', '--client', 'codex']);
    expect(npxCalls().at(-1)?.[1]).toEqual([
      '-y',
      'skills',
      'add',
      'hookmyapp/agent-skills',
      '--all',
      '--global',
    ]);
  });
});
