import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { cliConfigDir } from '../helpers/tmpHome.js';

/**
 * AIT-460 — the credential handed to MCP clients, against a real backend.
 *
 * The seeded session is a WorkOS JWT (accessToken + refreshToken, no `kind`),
 * which is exactly the session this ticket is about: that token carries no
 * `aud` claim, so `/mcp` rejects it. `mcp-headers` has to mint an org
 * credential instead of passing the session through.
 *
 * Runs against the local docker backend the integration profile defaults to
 * (`docker compose up -d backend`), verified green there — the seeded session
 * carries an org claim, so the mint succeeds locally and this needs no staging
 * gate.
 *
 * This suite exists because the unit tests could not catch the bug that
 * shipped. They mocked `POST /agent/credentials` with the field name the CLI
 * assumed (`accessToken`) rather than the one the server sends (`token`), so
 * the code and its test agreed with each other and both were wrong. Only a
 * real response settles a wire contract — hence a spec here rather than
 * another mock.
 */
describe('mcp-headers (AIT-460)', () => {
  it('mints an org credential instead of handing over the session JWT', async () => {
    const session = await seedSession();
    // finally, not a trailing call: a failed assertion below would otherwise
    // skip the logout and strand a live key on the shared test org — and a
    // failing assertion here is exactly when this test is most likely to run.
    try {
      const sessionToken = JSON.parse(
        await readFile(path.join(cliConfigDir(session.home), 'credentials.json'), 'utf8'),
      ).accessToken as string;

      const { exitCode, stdout } = await runCli(['mcp-headers'], { home: session.home });

      expect(exitCode).toBe(0);
      const headers = JSON.parse(stdout) as { Authorization: string };
      // hmok_ is the whole point: a JWT here is the bug.
      expect(headers.Authorization).toMatch(/^Bearer hmok_/);
      expect(headers.Authorization).not.toContain(sessionToken);
    } finally {
      // logout revokes this machine's keys by name, so it also sweeps a key a
      // half-finished run minted but never recorded.
      await runCli(['logout'], { home: session.home });
    }
  });

  it('reuses the minted credential rather than minting on every call', async () => {
    // MCP clients invoke the helper on every request; a mint per call would
    // pile up keys on the user's API-keys page and rate-limit them.
    const session = await seedSession();

    try {
      const first = await runCli(['mcp-headers'], { home: session.home });
      const second = await runCli(['mcp-headers'], { home: session.home });

      expect(first.exitCode).toBe(0);
      expect(second.stdout.trim()).toBe(first.stdout.trim());
    } finally {
      await runCli(['logout'], { home: session.home });
    }
  });
});
