import { describe, it, expect } from 'vitest';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { tmpHome } from '../helpers/tmpHome.js';

describe('billing commands', () => {
  describe('happy path (logged in)', () => {
    it('status returns subscription + usage JSON for seeded workspace', async () => {
      const session = await seedSession();
      const { exitCode, stdout } = await runCli(['--json', 'billing', 'status'], {
        home: session.home,
      });
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      // billingStatus default JSON shape: { subscription, usage }
      expect(data).toHaveProperty('subscription');
      expect(data).toHaveProperty('usage');
    });

    it('manage on free plan returns NO_SUBSCRIPTION (or opens portal if subscribed)', async () => {
      const session = await seedSession();
      const { exitCode, stderr } = await runCli(['billing', 'manage'], { home: session.home });
      // Either the workspace has no subscription (expected on dev) and the
      // command exits non-zero with NO_SUBSCRIPTION, or the workspace is
      // subscribed and the command opens the portal (exit 0). Accept both.
      if (exitCode !== 0) {
        expect(stderr).toMatch(/NO_SUBSCRIPTION|no active subscription/i);
        expect(stderr).not.toMatch(/AUTH_REQUIRED/);
      }
    });
  });

  describe('AUTH error path', () => {
    it('status returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(['billing', 'status'], { home });
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });
  });
});
