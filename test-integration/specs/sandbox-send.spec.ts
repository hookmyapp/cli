import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { seedSession } from '../helpers/seedSession.js';
import { runCli } from '../helpers/runCli.js';

// Phase 108-09: exercises `hookmyapp sandbox send` against the local backend
// + local sandbox-proxy (http://localhost:4315), via the E2E-mock branch
// enabled by seedSession({ includeSandboxSession }). An `e2e-`-prefixed
// activation code short-circuits Meta forwarding — the proxy returns a fake
// Graph API envelope for normal recipients and 403 for recipients whose
// phone starts with 99999 (reserved rejection marker).
const LOCAL_SANDBOX_PROXY_URL =
  process.env.E2E_SANDBOX_PROXY_URL ?? 'http://localhost:4315';

// Use a unique phone per run so concurrent pre-push checks don't trip the
// partial unique index on (phone, status) across workspaces.
function uniqueTestPhone(): string {
  const tail = randomUUID().replace(/-/g, '').slice(0, 10);
  // E.164: country code + 9 digits. Prefix 1555 is North American test range.
  // The last 6 characters are hex-derived digits; re-encode to digits only.
  const digits = tail.replace(/[a-f]/g, (c) =>
    String((c.charCodeAt(0) - 'a'.charCodeAt(0)) % 10),
  );
  return `+1555${digits.slice(0, 6)}`;
}

describe('hookmyapp sandbox send', () => {
  it(
    'flag-complete send → 200 response → exit 0 with wamid in output (human mode)',
    async () => {
      const phone = uniqueTestPhone();
      const seeded = await seedSession({
        includeSandboxSession: { phone },
      });
      try {
        const result = await runCli(
          [
            'sandbox',
            'send',
            '--phone',
            phone,
            '--to',
            '+15550000000',
            '--message',
            'hello from phase-108 integration',
          ],
          {
            home: seeded.home,
            env: { HOOKMYAPP_SANDBOX_PROXY_URL: LOCAL_SANDBOX_PROXY_URL },
          },
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
    'send that the proxy rejects with 403 → exit 1 (ApiError) with proxy error message on stderr',
    async () => {
      const phone = uniqueTestPhone();
      const seeded = await seedSession({
        includeSandboxSession: { phone },
      });
      try {
        const result = await runCli(
          [
            '--json',
            'sandbox',
            'send',
            '--phone',
            phone,
            // Recipient prefix +99999 is the reserved E2E-mock rejection
            // marker — sandbox-proxy returns 403 so the CLI surfaces an
            // ApiError (exit 1) with the proxy error message on stderr.
            '--to',
            '+99999000000',
            '--message',
            'this should be rejected by the e2e proxy',
          ],
          {
            home: seeded.home,
            env: { HOOKMYAPP_SANDBOX_PROXY_URL: LOCAL_SANDBOX_PROXY_URL },
          },
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
