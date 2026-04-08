import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test-integration/**/*.spec.ts'],
    // 260407-jy9: nightly/** holds the slow Playwright AuthKit puppeting
    // flow; it runs on a separate cron schedule, never on PRs.
    exclude: ['test-integration/nightly/**', '**/node_modules/**'],
    globalSetup: ['./test-integration/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Specs hit a shared dev DB; serial avoids workspace-name collisions.
    fileParallelism: false,
    pool: 'forks',
  },
});
