import { build } from 'esbuild';

// Phase 123 Plan 10 — observability build config.
//
// 1. Tree-shake Sentry. `__SENTRY_TRACING__=false` + `__SENTRY_DEBUG__=false`
//    strip the tracing/profiling/debug code paths from @sentry/node at bundle
//    time. Cuts ~300 KB of dead code that the CLI never needs (CLI is
//    short-lived + doesn't emit spans).
//
// 2. Bake HOOKMYAPP_SENTRY_DSN + HOOKMYAPP_CLI_RELEASE into the bundle via
//    esbuild `define`. publish-cli.yml passes these as env vars to the build
//    step so the published binary has the DSN ready on user machines (users
//    don't set their own DSN). Dev builds (`node build.mjs` locally without
//    these env vars) bake empty strings — initSentryLazy() then no-ops.
//
// 3. Emit sourcemap for future sentry-cli sourcemap upload (publish-cli.yml
//    step — gated on SENTRY_AUTH_TOKEN availability).
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'esm',
  bundle: true,
  sourcemap: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire } from "module";',
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  define: {
    // Strip Sentry tracing/debug at bundle time.
    __SENTRY_TRACING__: 'false',
    __SENTRY_DEBUG__: 'false',
    // Inject DSN + release at build time (publish-cli.yml sets these from
    // GitHub Actions secrets + ${{ github.ref_name }} respectively).
    'process.env.HOOKMYAPP_SENTRY_DSN': JSON.stringify(
      process.env.HOOKMYAPP_SENTRY_DSN ?? '',
    ),
    'process.env.HOOKMYAPP_CLI_RELEASE': JSON.stringify(
      process.env.HOOKMYAPP_CLI_RELEASE ?? '',
    ),
  },
  external: [],
});

console.log('Built dist/cli.js');
