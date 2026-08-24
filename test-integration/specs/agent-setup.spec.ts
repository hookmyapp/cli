import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { cliConfigDir } from '../helpers/tmpHome.js';
import { HOOKMYAPP_API_URL } from '../helpers/env.js';

/**
 * AIT-468 — one login, every tool, against a real backend.
 *
 * The unit tests can only assert that `agent setup` writes the strings this
 * repo believes each client wants. Whether the credential in those strings is
 * one `/mcp` accepts is a wire question, and the last time it was answered by
 * a mock the answer was wrong (AIT-460: the CLI read `accessToken`, the server
 * sends `token`, and every unit test agreed with the CLI).
 *
 * So this drives the two client paths that carry a credential and asks the
 * server:
 *   - Cursor stores the token literally in ~/.cursor/mcp.json
 *   - Codex invokes `mcp-headers --header x-api-key` per request
 * Both must reach tools/list, and the JWT they replaced must not.
 */
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

async function callMcp(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${HOOKMYAPP_API_URL.replace(/\/$/, '')}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: TOOLS_LIST,
  });
  return res.status;
}

describe('agent setup (AIT-468)', () => {
  it('hands Cursor and Codex a credential /mcp accepts, and not the session JWT', async () => {
    const session = await seedSession();
    const sessionToken = JSON.parse(
      await readFile(path.join(cliConfigDir(session.home), 'credentials.json'), 'utf8'),
    ).accessToken as string;

    const setup = await runCli(['agent', 'setup', '--client', 'cursor', '--no-skills'], {
      home: session.home,
    });
    expect(setup.exitCode).toBe(0);
    // The old copy told Cursor users to go sign in a second time. That instruction
    // existing at all is the bug this ticket closes.
    expect(setup.stdout).not.toMatch(/sign in/i);

    const cursor = JSON.parse(
      await readFile(path.join(session.home, '.cursor', 'mcp.json'), 'utf8'),
    ) as { mcpServers: { hookmyapp: { url: string; headers: { Authorization: string } } } };
    const entry = cursor.mcpServers.hookmyapp;
    expect(entry.url).toBe(`${HOOKMYAPP_API_URL.replace(/\/$/, '')}/mcp`);
    const cursorToken = entry.headers.Authorization.replace('Bearer ', '');
    expect(cursorToken).toMatch(/^hmok_/);

    // What Codex runs per request. Its `http_headers_helper` refuses to send
    // Authorization, so this path has to work through X-API-Key.
    const helper = await runCli(['mcp-headers', '--header', 'x-api-key'], { home: session.home });
    expect(helper.exitCode).toBe(0);
    const codexToken = (JSON.parse(helper.stdout) as Record<string, string>)['X-API-Key'];

    // One login, one credential — not one per client.
    expect(codexToken).toBe(cursorToken);

    expect(await callMcp({ Authorization: `Bearer ${cursorToken}` })).toBe(200);
    expect(await callMcp({ 'X-API-Key': codexToken })).toBe(200);
    // The whole reason the mint exists: this token has no `aud` claim.
    expect(await callMcp({ Authorization: `Bearer ${sessionToken}` })).toBe(401);

    // Revoke rather than leave a live key behind on the shared test org.
    await runCli(['logout'], { home: session.home });
  });
});
