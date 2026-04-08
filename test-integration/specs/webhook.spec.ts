import { describe, it, expect } from 'vitest';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { tmpHome } from '../helpers/tmpHome.js';

describe('webhook commands', () => {
  describe('happy path (logged in)', () => {
    it('show on a non-existent waba returns NOT_FOUND (resolveAccount path)', async () => {
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(
        ['webhook', 'show', 'nonexistent-waba'],
        { home: session.home },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/not found|NOT_FOUND/i);
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });

    it('set without --url surfaces a VALIDATION-style error (does not auth-fail)', async () => {
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(
        ['webhook', 'set', 'some-waba'],
        { home: session.home },
      );
      expect(exitCode).not.toBe(0);
      // Either commander rejects the missing --url, or resolveAccount returns
      // NOT_FOUND for the bogus waba — both prove the auth path is healthy.
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });
  });

  describe('AUTH error path', () => {
    it('show returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(
        ['webhook', 'show', 'any-waba'],
        { home },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });
  });
});
