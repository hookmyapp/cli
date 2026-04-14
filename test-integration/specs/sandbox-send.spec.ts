import { describe, it, expect } from 'vitest';
import { seedSession } from '../helpers/seedSession.js';
import { runCli } from '../helpers/runCli.js';

// Wave 0 RED: exercises `hookmyapp sandbox send` against the real backend
// and sandbox-proxy. RED because the `send` subcommand is not registered on
// the sandbox command group yet — the CLI exits with
// `error: unknown command 'send'`.
describe('hookmyapp sandbox send — Wave 0 RED', () => {
  it(
    'flag-complete send → 200 response → exit 0 with wamid in output (human mode)',
    async () => {
      const seeded = await seedSession();
      try {
        const result = await runCli(
          [
            'sandbox',
            'send',
            '--phone',
            process.env.E2E_SANDBOX_PHONE ?? '+15551234567',
            '--to',
            process.env.E2E_SANDBOX_TEST_TO ?? '+15550000000',
            '--message',
            'hello from wave-0 RED',
          ],
          { home: seeded.home },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toLowerCase()).toContain('message sent');
        expect(result.stdout).toMatch(/wamid\./);
      } finally {
        await seeded.cleanup();
      }
    },
    30_000,
  );

  it(
    'template send that the proxy rejects with 403 → exit 1 (ApiError) with proxy error message on stderr',
    async () => {
      const seeded = await seedSession();
      try {
        const result = await runCli(
          [
            'sandbox',
            'send',
            '--phone',
            process.env.E2E_SANDBOX_PHONE ?? '+15551234567',
            '--to',
            process.env.E2E_SANDBOX_TEST_TO ?? '+15550000000',
            '--message',
            // Template placeholder that the sandbox-proxy declines.
            '[[template:unknown-template]]',
            '--json',
          ],
          { home: seeded.home },
        );
        expect(result.exitCode).toBe(1);
        // JSON error envelope on stderr contains either a code or message.
        expect(result.stderr.length).toBeGreaterThan(0);
      } finally {
        await seeded.cleanup();
      }
    },
    30_000,
  );
});
