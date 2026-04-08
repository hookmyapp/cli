import { describe, it, expect } from 'vitest';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { tmpHome } from '../helpers/tmpHome.js';

describe('auth commands', () => {
  describe('happy path (logged in)', () => {
    it('logout deletes credentials.json', async () => {
      const session = await seedSession();
      const credsPath = path.join(session.home, '.hookmyapp', 'credentials.json');
      await access(credsPath); // exists before
      const { exitCode } = await runCli(['logout'], { home: session.home });
      expect(exitCode).toBe(0);
      await expect(access(credsPath)).rejects.toThrow(); // gone after
    });

    it('token <waba-id> resolves auth and surfaces NOT_FOUND for an unknown account', async () => {
      // The real `token` command takes a <waba-id> arg and reveals the access
      // token for the matching Meta account. We don't seed a real account in
      // this suite, so the happy "auth path" we can verify is: credentials work,
      // request reaches the backend, and the resolver returns a structured
      // NOT_FOUND error (NOT an AUTH error). That proves the seeded session is
      // valid against the live backend.
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(['token', 'nonexistent-waba'], {
        home: session.home,
      });
      expect(exitCode).not.toBe(0);
      // Must be NOT_FOUND, not AUTH — proves the credentials authenticated.
      expect(stderr).toMatch(/NOT_FOUND|not found/i);
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });

    it('env <waba-id> resolves auth and surfaces NOT_FOUND for an unknown account', async () => {
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(['env', 'nonexistent-waba'], {
        home: session.home,
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/NOT_FOUND|not found/i);
      expect(stderr).not.toMatch(/AUTH_REQUIRED/);
    });
  });

  describe('AUTH error path', () => {
    it('logout is a local no-op even without credentials', async () => {
      // logout simply unlinks ~/.hookmyapp/credentials.json. With nothing to
      // unlink it must still exit 0 (commands/auth/logout.ts swallows ENOENT).
      const home = await tmpHome();
      const { exitCode } = await runCli(['logout'], { home });
      expect(exitCode).toBe(0);
    });

    it('token <waba-id> returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(['token', 'any-waba'], { home });
      expect(exitCode).not.toBe(0);
      // CLI prints structured JSON to stderr: {"error":"...","code":"AUTH_REQUIRED",...}
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });

    it('env <waba-id> returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(['env', 'any-waba'], { home });
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });
  });
});
