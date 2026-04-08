import { defineConfig } from 'vitest/config';

/**
 * 260407-jy9: Nightly-only config for the real WorkOS AuthKit puppeting flow
 * (cli/test-integration/nightly/00-login-real.spec.ts). Runs on a daily cron
 * via .github/workflows/nightly-cli-login.yml against staging — never on PRs.
 */
export default defineConfig({
  test: {
    include: ['test-integration/nightly/**/*.spec.ts'],
    globalSetup: ['./test-integration/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
