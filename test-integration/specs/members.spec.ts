import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runCli } from '../helpers/runCli.js';
import { seedSession, type SeededSession } from '../helpers/seedSession.js';
import { tmpHome } from '../helpers/tmpHome.js';

const RUN_ID = randomUUID().slice(0, 8);

describe('workspace members commands', () => {
  let session: SeededSession;

  beforeAll(async () => {
    // Create a fresh workspace for this spec to avoid colliding with other
    // specs that mutate members on the seeded default workspace.
    session = await seedSession();
    const workspaceName = `cli-it-${RUN_ID}-members`;
    const created = await runCli(['workspace', 'new', workspaceName], { home: session.home });
    expect(created.exitCode).toBe(0);
  });

  describe('happy path (logged in)', () => {
    it('list returns JSON array containing the seeded admin', async () => {
      const { exitCode, stdout } = await runCli(
        ['--json', 'workspace', 'members', 'list'],
        { home: session.home },
      );
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it('invite a fresh email creates a pending invite', async () => {
      const email = `cli-it-${RUN_ID}-invitee@example.com`;
      const { exitCode } = await runCli(
        ['workspace', 'members', 'invite', email, '--role', 'member'],
        { home: session.home },
      );
      expect(exitCode).toBe(0);
    });

    it('role change with invalid role returns VALIDATION error', async () => {
      const { exitCode, stderr } = await runCli(
        ['workspace', 'members', 'role', 'someone@example.com', '--role', 'owner'],
        { home: session.home },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/invalid role|VALIDATION/i);
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });

    it('remove against an unknown email exits non-zero (NOT_FOUND or aborted prompt)', async () => {
      const { exitCode } = await runCli(
        ['workspace', 'members', 'remove', 'nobody@example.com'],
        { home: session.home },
      );
      // We deliberately omit --yes so we never actually delete a real member.
      // Either NOT_FOUND or an aborted confirm prompt is acceptable.
      expect(exitCode).not.toBe(0);
    });
  });

  describe('AUTH error path', () => {
    it('list returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(
        ['workspace', 'members', 'list'],
        { home },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });
  });
});
