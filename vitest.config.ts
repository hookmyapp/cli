import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/__tests__/**/*.{test,spec}.ts'],
    // vitest.setup.ts redirects HOOKMYAPP_CONFIG_DIR to a tmp dir BEFORE any
    // test module loads — prevents tests from clobbering the developer's
    // real ~/.hookmyapp credentials + active workspace config.
    setupFiles: ['./vitest.setup.ts'],
    // The Windows runner is slow enough that the fake-timer poll tests in
    // billing.test.ts blow the 30s default while stepping timers — a runner
    // speed difference, not a product bug (AIT-395).
    testTimeout: process.platform === 'win32' ? 60_000 : 30_000,
    coverage: {
      include: ['src/**'],
    },
  },
});
