import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { execa, type ResultPromise } from 'execa';
import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpHome } from '../helpers/tmpHome.js';
import { SHARED_CREDS_PATH } from '../helpers/seedSession.js';
import { CLI_BIN } from '../helpers/runCli.js';
import { HOOKMYAPP_API_URL, HOOKMYAPP_WORKOS_CLIENT_ID } from '../helpers/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function waitForFile(p: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await stat(p);
      if (s.size > 0) {
        const content = await readFile(p, 'utf-8');
        if (content.trim().length > 0) return content.trim();
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`[00-login] timed out waiting for ${p} after ${timeoutMs}ms`);
}

describe('hookmyapp login (nightly only — real WorkOS UI puppeting)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it(
    'completes WorkOS device-code login and writes credentials.json',
    async () => {
      const home = await tmpHome();

      // Test affordance: tell the CLI to write the verification URI to this file
      // (instead of relying on `open()` which we can't intercept).
      const urlFile = path.join(tmpdir(), `hookmyapp-login-url-${Date.now()}.txt`);

      const child: ResultPromise = execa('node', [CLI_BIN, 'login'], {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          HOOKMYAPP_API_URL,
          HOOKMYAPP_WORKOS_CLIENT_ID,
          HOOKMYAPP_LOGIN_URL_FILE: urlFile,
          // Prevent `open` from spawning a real browser on the host OS.
          BROWSER: 'none',
        },
        reject: false,
        timeout: 110_000,
      });

      // Buffer stderr/stdout in case the spec fails — useful diagnostics.
      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout?.on('data', (c) => (stdoutBuf += c.toString()));
      child.stderr?.on('data', (c) => (stderrBuf += c.toString()));

      // Wait for the CLI to publish the verification URL.
      const verificationUri = await waitForFile(urlFile, 30_000);
      expect(verificationUri).toMatch(/^https:\/\//);

      // Drive the WorkOS AuthKit device-authorization page in a headless browser.
      // Force English locale — WorkOS AuthKit honors Accept-Language and otherwise
      // serves localized strings (e.g. Dutch "Teken in" instead of "Sign in"), which
      // breaks any name-based selector.
      const context = await browser.newContext({
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
      const page = await context.newPage();

      const dumpDir = path.resolve(__dirname, '../.cache');
      await mkdir(dumpDir, { recursive: true }).catch(() => {});
      const dump = async (label: string) => {
        await page
          .screenshot({ path: path.join(dumpDir, `login-${label}.png`), fullPage: true })
          .catch(() => {});
        await writeFile(
          path.join(dumpDir, `login-${label}.html`),
          await page.content().catch(() => ''),
        ).catch(() => {});
        // eslint-disable-next-line no-console
        console.error(`[00-login] dump ${label}: url=${page.url()}`);
      };

      try {
        await page.goto(verificationUri, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await dump('01-landing');

        // Locale-agnostic: target submit buttons by type, not name.
        await page.locator('input[type="email"]').fill(process.env.E2E_ADMIN_EMAIL!);
        await page.locator('button[type="submit"]').first().click();

        const passwordField = page.locator('input[type="password"]');
        await passwordField.waitFor({ timeout: 15_000 });
        await dump('02-password-page');
        await passwordField.fill(process.env.E2E_ADMIN_PASSWORD!);
        await page.locator('button[type="submit"]').first().click();

        // After password submit, WorkOS device-auth may show:
        //   1. Organization picker (h1 "Select an organization to continue")
        //   2. Device activation confirm page (h1 "Device activation", buttons
        //      name="action" value="confirm"|"deny")
        //   3. Final "Activation successful" / "Activation denied"
        // We click through deterministically using H1/title, not URL (the flow
        // stays on the same /device/* URL across React re-renders).
        await dump('03-after-password');

        // Step A: org picker (optional — only if the account has an org choice).
        const orgPickerHeading = page.getByRole('heading', {
          name: /select an organization/i,
        });
        if (
          await orgPickerHeading
            .waitFor({ timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
        ) {
          await dump('04-org-picker');
          const orgBtn = page.locator('button[name="organization_id"]').first();
          await orgBtn.click({ timeout: 10_000 });
          // Wait until the org picker heading goes away — next page has loaded.
          await orgPickerHeading.waitFor({ state: 'detached', timeout: 15_000 });
        }

        // Step B: device activation confirm page. WorkOS AuthKit uses
        //   <button name="action" type="submit" value="confirm"> Confirm </button>
        //   <button name="action" type="submit" value="deny">   Deny    </button>
        // We MUST click confirm (not deny).
        const confirmBtn = page.locator('button[name="action"][value="confirm"]');
        await confirmBtn.waitFor({ timeout: 15_000 });
        await dump('05-device-confirm');
        await confirmBtn.click({ timeout: 10_000 });

        // Step C: wait for the "Activation successful" final page so we know
        // the device endpoint transitioned and the CLI's next poll will return
        // tokens. Guard against the denied path to fail fast.
        await Promise.race([
          page
            .getByRole('heading', { name: /you are all set|device connected|activation successful/i })
            .waitFor({ timeout: 20_000 }),
          page
            .getByRole('heading', { name: /activation denied/i })
            .waitFor({ timeout: 20_000 })
            .then(() => {
              throw new Error('[00-login] device activation was denied');
            }),
        ]);
        await dump('06-final');
      } catch (err) {
        await dump('error').catch(() => {});
        // eslint-disable-next-line no-console
        console.error('[00-login] browser flow error:', err);
        throw err;
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }

      // Now wait for the CLI to finish polling and exit.
      const result = await child;
      if (result.exitCode !== 0) {
        // eslint-disable-next-line no-console
        console.error('[00-login] CLI failed.\nSTDOUT:\n' + stdoutBuf + '\nSTDERR:\n' + stderrBuf);
      }
      expect(result.exitCode).toBe(0);

      // Verify credentials.json landed in the isolated HOME.
      const credsPath = path.join(home, '.hookmyapp', 'credentials.json');
      expect(existsSync(credsPath)).toBe(true);
      const creds = JSON.parse(await readFile(credsPath, 'utf-8'));
      expect(creds.accessToken).toBeTruthy();
      expect(creds.refreshToken).toBeTruthy();
      expect(typeof creds.expiresAt).toBe('number');

      // Stash for downstream specs (auth.spec.ts, workspace.spec.ts, plan 03 specs).
      await mkdir(path.dirname(SHARED_CREDS_PATH), { recursive: true });
      await copyFile(credsPath, SHARED_CREDS_PATH);
    },
    120_000,
  );
});
