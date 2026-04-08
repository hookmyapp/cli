import { describe, it, expect } from 'vitest';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { tmpHome } from '../helpers/tmpHome.js';

describe('accounts commands', () => {
  describe('happy path (logged in)', () => {
    it('list returns JSON array (possibly empty) for seeded admin workspace', async () => {
      const session = await seedSession();
      const { exitCode, stdout } = await runCli(['accounts', 'list'], { home: session.home });
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(Array.isArray(data)).toBe(true);
    });

    it('enable on a non-existent waba returns NOT_FOUND (proves auth path)', async () => {
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(
        ['accounts', 'enable', 'nonexistent-waba'],
        { home: session.home },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/not found|NOT_FOUND/i);
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });

    it('disable on a non-existent waba returns NOT_FOUND (proves auth path)', async () => {
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(
        ['accounts', 'disable', 'nonexistent-waba'],
        { home: session.home },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/not found|NOT_FOUND/i);
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });
  });

  describe('AUTH error path', () => {
    it('list returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(['accounts', 'list'], { home });
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });
  });
});
