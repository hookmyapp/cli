import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/__tests__/**/*.{test,spec}.ts'],
    // vitest.setup.ts redirects HOOKMYAPP_CONFIG_DIR to a tmp dir BEFORE any
    // test module loads — prevents tests from clobbering the developer's
    // real ~/.hookmyapp credentials + active workspace config.
    setupFiles: ['./vitest.setup.ts'],
    // billing.test.ts's fake-timer poll tests step timers up to 500 times, and
    // under full-suite load on a CI runner that blows the 30s default — seen
    // on both windows-latest and ubuntu-latest. Runner speed, not a product
    // bug (AIT-395).
    testTimeout: 60_000,
    coverage: {
      include: ['src/**'],
    },
  },
});
