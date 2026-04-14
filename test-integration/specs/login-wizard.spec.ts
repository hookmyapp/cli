import { describe, it, expect } from 'vitest';
import { seedSession } from '../helpers/seedSession.js';
import { runCli } from '../helpers/runCli.js';

// Wave 0 RED: exercises the post-login wizard end-to-end against the mocked
// backend. The wizard routes `--wizard --next=exit` through runWizard() →
// workspace auto-select → next-action picker "exit" → clean exit 0. This is
// RED because:
//   (a) `hookmyapp login --wizard` flag is not registered on the login command
//   (b) runWizard() is not exported / wired into the login action
// so the CLI exits non-zero ("unknown option: --wizard") today.
describe('hookmyapp login wizard — Wave 0 RED', () => {
  it(
    'wizard --next=exit selects workspace silently and exits 0',
    async () => {
      const seeded = await seedSession();
      try {
        const result = await runCli(
          ['login', '--wizard', '--next=exit', '--json'],
          { home: seeded.home },
        );
        expect(result.exitCode).toBe(0);
        // JSON mode: wizard emits a structured completion payload.
        // (Wave 2 decides the exact shape; RED asserts non-empty stdout
        // rather than field names to stay decoupled from implementation.)
        expect(result.stdout).not.toBe('');
      } finally {
        await seeded.cleanup();
      }
    },
    30_000,
  );

  it(
    'wizard --next=sandbox with zero sessions prompts for phone (flag-driven mode errors out in --json)',
    async () => {
      const seeded = await seedSession();
      try {
        // In --json mode, sandbox sub-flow requires --phone to avoid TTY
        // prompts; without it, the wizard exits with a ValidationError (exit 2).
        const result = await runCli(
          ['login', '--wizard', '--next=sandbox', '--json'],
          { home: seeded.home },
        );
        // Either exit 2 (ValidationError in JSON mode, no --phone) OR exit 6
        // (ConflictError if a test phone was already taken). Both satisfy the
        // RED contract: wizard routes into sandbox flow and surfaces a
        // structured error class, not a raw stack.
        expect([2, 6]).toContain(result.exitCode);
      } finally {
        await seeded.cleanup();
      }
    },
    30_000,
  );
});
