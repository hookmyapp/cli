import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/cli.js',
  platform: 'node',
  format: 'esm',
  bundle: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      'import { createRequire } from "module";',
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  external: [],
});

console.log('Built dist/cli.js');
