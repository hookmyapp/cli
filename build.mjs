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
    // Phase 125 Plan 02 — bake PostHog token + host at build time. Same
    // pattern as the Sentry DSN: publish-cli.yml passes HOOKMYAPP_POSTHOG_TOKEN
    // + HOOKMYAPP_POSTHOG_HOST as build env vars sourced from GitHub repo
    // secrets. Dev builds without these vars bake empty strings → lazy init
    // no-ops. Token is a public phc_ key (safe to bake; same security profile
    // as frontend VITE_PUBLIC_POSTHOG_TOKEN per CONTEXT.md §2).
    'process.env.HOOKMYAPP_POSTHOG_TOKEN': JSON.stringify(
      process.env.HOOKMYAPP_POSTHOG_TOKEN ?? '',
    ),
    'process.env.HOOKMYAPP_POSTHOG_HOST': JSON.stringify(
      process.env.HOOKMYAPP_POSTHOG_HOST ?? '',
    ),
  },
  // Keep @sentry/node + posthog-node external — real runtime deps (not
  // devDeps), resolved from the installed node_modules tree. Inlining
  // @sentry/node would add ~416KB gzip (OpenTelemetry fan-out); posthog-node
  // is smaller but following the same pattern keeps the dist/cli.js bundle
  // under the Plan 10 target of ≤ 100KB gzip delta and the dynamic-import
  // fast path in posthog.ts loads it only when telemetry is enabled + token
  // baked.
  external: ['@sentry/node', 'posthog-node'],
});

console.log('Built dist/cli.js');
