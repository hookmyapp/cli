import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpHome } from '../helpers/tmpHome.js';
import { SHARED_CREDS_PATH } from '../helpers/seedSession.js';
import { HOOKMYAPP_API_URL } from '../helpers/env.js';

/**
 * 260407-jy9: PR-path login shim.
 *
 * Replaces the brittle headless-browser AuthKit puppeting flow (now lives at
 * test-integration/nightly/00-login-real.spec.ts) with a single HTTP call to
 * the backend test-only endpoint POST /internal/e2e/cli-login. The endpoint
 * mints real WorkOS user-context tokens via authenticateWithPassword and is
 * gated on E2E_PROVISION_SECRET.
 *
 * Downstream specs (auth, workspace, accounts, billing, members, webhook)
 * continue to consume SHARED_CREDS_PATH unchanged.
 */
describe('hookmyapp login (PR path — internal cli-login bypass)', () => {
  it(
    'mints credentials via internal cli-login bypass',
    async () => {
      const secret = process.env.E2E_PROVISION_SECRET;
      const email = process.env.E2E_ADMIN_EMAIL;
      const password = process.env.E2E_ADMIN_PASSWORD;
      // assertEnv() in global-setup already enforces these are set; this is
      // belt-and-suspenders for the type narrowing below.
      if (!secret || !email || !password) {
        throw new Error(
          '[00-login] E2E_PROVISION_SECRET / E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD must be set',
        );
      }

      const url = `${HOOKMYAPP_API_URL}/internal/e2e/cli-login`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-e2e-secret': secret,
        },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `[00-login] cli-login bypass failed: ${res.status} ${res.statusText} — ${text}`,
        );
      }

      const creds = (await res.json()) as {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
      };
      expect(creds.accessToken).toBeTruthy();
      expect(creds.refreshToken).toBeTruthy();
      expect(typeof creds.expiresAt).toBe('number');
      expect(creds.expiresAt).toBeGreaterThan(Date.now());

      // Mirror the original post-condition: write credentials.json into an
      // isolated tmpHome at <home>/.hookmyapp/credentials.json with mode 0600.
      const home = await tmpHome();
      const credsPath = path.join(home, '.hookmyapp', 'credentials.json');
      await mkdir(path.dirname(credsPath), { recursive: true });
      const credsJson = JSON.stringify(creds);
      await writeFile(credsPath, credsJson);
      await chmod(credsPath, 0o600);

      // Stash for downstream specs (auth.spec.ts, workspace.spec.ts, …).
      await mkdir(path.dirname(SHARED_CREDS_PATH), { recursive: true });
      await writeFile(SHARED_CREDS_PATH, credsJson);
    },
    15_000,
  );
});
