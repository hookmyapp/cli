import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
}));

import {
  configureCursor,
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  test('detects only the CLIs that answer --version', () => {
    // claude present, codex absent. Cursor is filesystem-detected, so a
    // machine with ~/.cursor reports it either way — assert on the CLIs.
    vi.mocked(runTool).mockReturnValueOnce(ok).mockReturnValueOnce(enoent);

    const found = detectClients();

    expect(found).toContain('claude');
    expect(found).not.toContain('codex');
  });

  const codexHas = (url: string) => ({ status: 0, stdout: `url: ${url}` }) as never;
  const codexMissing = { status: 1, stderr: 'No MCP server' } as never;

  test('finds nothing when no agent is installed', () => {
    vi.mocked(runTool).mockReturnValue(enoent);

    expect(detectClients(join(tmpdir(), 'hookmyapp-no-such-cursor-dir'))).toEqual([]);
  });

  test('adds the Codex server by URL, not by static token', () => {
    vi.mocked(runTool)
      .mockReturnValueOnce(codexMissing) // get: nothing configured yet
      .mockReturnValueOnce(ok) // add
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp')); // get: verify

    runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(vi.mocked(runTool).mock.calls[1][1]).toEqual([
      'mcp',
      'add',
      'hookmyapp',
      '--url',
      'https://api.hookmyapp.com/mcp',
    ]);
    expect(JSON.stringify(vi.mocked(runTool).mock.calls)).not.toContain('Bearer');
  });

  test('trusts the Codex config over the hanging add command exit status', () => {
    // `codex mcp add` writes and then never exits, so runTool always reports a
    // timeout. The read-back is what decides.
    vi.mocked(runTool)
      .mockReturnValueOnce(codexMissing)
      .mockReturnValueOnce({ status: null, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) } as never)
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runAgentSetup({ client: 'codex', skills: false, json: true });

    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0])).clients[0].status).toBe('configured');
  });

  test('replaces a Codex entry left behind by another environment', () => {
    vi.mocked(runTool)
      .mockReturnValueOnce(codexHas('https://staging-api.hookmyapp.com/mcp'))
      .mockReturnValueOnce(ok) // remove
      .mockReturnValueOnce(ok) // add
      .mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(vi.mocked(runTool).mock.calls[1][1]).toEqual(['mcp', 'remove', 'hookmyapp']);
  });

  test('leaves a correct Codex entry alone', () => {
    vi.mocked(runTool).mockReturnValueOnce(codexHas('https://api.hookmyapp.com/mcp'));

    runAgentSetup({ client: 'codex', skills: false, json: false });

    expect(runTool).toHaveBeenCalledOnce();
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

  test('reports a failed client instead of aborting the run', () => {
    vi.mocked(runTool).mockReturnValue(codexMissing);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runAgentSetup({ client: 'codex', skills: false, json: true });

    const parsed = JSON.parse(String(write.mock.calls.at(-1)?.[0]));
    expect(parsed.skills).toBeNull();
    expect(parsed.clients[0]).toMatchObject({ client: 'codex', status: 'failed' });
    expect(parsed.clients[0].detail).toContain('codex mcp add');
  });

  test('keeps login progress off stdout so --json stays parseable', () => {
    vi.mocked(runTool).mockReturnValue(ok);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    maybeSetupAgents(true);

    expect(out).not.toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toContain('HookMyApp MCP configured for');
  });

  test('tells every client it needs a restart before the new server is live', () => {
    vi.mocked(runTool).mockReturnValue(codexHas('https://api.hookmyapp.com/mcp'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    runAgentSetup({ client: 'codex', skills: false, json: true });

    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0])).clients[0].detail).toContain('restart Codex');
  });

  test('rejects an unknown client', () => {
    expect(() => runAgentSetup({ client: 'windsurf', skills: false, json: false })).toThrow(/Unsupported client/);
  });

  test('treats a missing npx as skipped, not failed', () => {
    vi.mocked(runTool).mockReturnValue(enoent);

    expect(installSkills()).toEqual({
      status: 'skipped',
      detail: 'npx not found — install Node.js 20+, then re-run',
    });
  });

  test('installs skills by default and skips them with --no-skills', async () => {
    vi.mocked(runTool).mockReturnValue(ok);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().option('--json');
    registerAgentCommand(program);

    await program.parseAsync(['node', 'hookmyapp', 'agent', 'setup', '--client', 'cursor', '--no-skills']);
    expect(vi.mocked(runTool)).not.toHaveBeenCalled();

    vi.mocked(runTool).mockReturnValue(codexHas('https://api.hookmyapp.com/mcp'));
    await program.parseAsync(['node', 'hookmyapp', 'agent', 'setup', '--client', 'codex']);
    expect(vi.mocked(runTool).mock.calls.at(-1)?.[1]).toEqual([
      '-y',
      'skills',
      'add',
      'hookmyapp/agent-skills',
      '--all',
      '--global',
    ]);
  });
});
