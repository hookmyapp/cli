import { execa } from 'execa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { assertEnv } from './helpers/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, '..');

export default async function globalSetup(): Promise<void> {
  const env = assertEnv();

  // 1. Fail-fast: backend reachable (no /health route exists; any HTTP response proves it's up)
  const reachable = await fetch(env.E2E_API_BASE_URL).catch(() => null);
  if (!reachable) {
    throw new Error(
      `[cli/global-setup] backend not reachable at ${env.E2E_API_BASE_URL}. ` +
        `Start docker compose first: docker compose up -d backend`,
    );
  }

  // 2. Build CLI once
  await execa('node', ['build.mjs'], { cwd: CLI_DIR, stdio: 'inherit' });

  // 3. Provision WorkOS users (idempotent — mirrors e2e/global-setup.ts)
  const url = `${env.E2E_API_BASE_URL.replace(/\/$/, '')}/internal/e2e/ensure-users`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-e2e-secret': env.E2E_PROVISION_SECRET,
    },
    body: JSON.stringify({
      admin: { email: env.E2E_ADMIN_EMAIL, password: env.E2E_ADMIN_PASSWORD },
      member: { email: env.E2E_MEMBER_EMAIL, password: env.E2E_MEMBER_PASSWORD },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`[cli/global-setup] provisioning failed ${res.status} from ${url}: ${text}`);
  }

  // 4. Ensure cache dir exists for shared credentials.json
  await mkdir(path.join(__dirname, '.cache'), { recursive: true });

  // eslint-disable-next-line no-console
  console.log('[cli/global-setup] CLI built, WorkOS users provisioned, ready');
}
