import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.{test,spec}.ts', 'src/**/__tests__/**/*.{test,spec}.ts'],
    // vitest.setup.ts redirects HOOKMYAPP_CONFIG_DIR to a tmp dir BEFORE any
    // test module loads — prevents tests from clobbering the developer's
    // real ~/.hookmyapp credentials + active workspace config.
    setupFiles: ['./vitest.setup.ts'],
  },
});
