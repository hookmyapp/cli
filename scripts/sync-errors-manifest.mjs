#!/usr/bin/env node
// Phase 123 Plan 10 — manifest sync script.
//
// Runs at CLI publish time (via the `prepublishOnly` npm script). Fetches the
// monorepo's `packages/observability/src/errors/manifest.json` from a pinned
// commit SHA via GitHub raw URL and writes to `src/errors/manifest.json`.
// The CI drift test (`src/__tests__/errors-manifest.test.ts`) flips from GREEN
// to RED if the manifest diverges from the CLI's local class definitions —
// either the sync script needs to be re-run at a newer pinned SHA, or the CLI
// subclass taxonomy needs to be updated in lockstep with the monorepo.
//
// Pin the monorepo SHA in `.observability-sync-sha` (alongside this script's
// repo root). To bump the pin: commit a newer SHA into that file and re-run
// `node scripts/sync-errors-manifest.mjs` before tagging a CLI release.
//
// Flags:
//   --check  Compare current manifest.json against the pinned SHA WITHOUT
//            writing. Exits 0 if identical, 1 if drifted. For CI use.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const PIN_FILE = resolve(repoRoot, '.observability-sync-sha');
const MANIFEST_PATH = resolve(repoRoot, 'src/errors/manifest.json');

if (!existsSync(PIN_FILE)) {
  console.error(
    `[sync-errors-manifest] missing ${PIN_FILE} — create it with a monorepo commit SHA.`,
  );
  process.exit(1);
}

const sha = readFileSync(PIN_FILE, 'utf8').trim();
if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
  console.error(
    `[sync-errors-manifest] invalid SHA in ${PIN_FILE}: "${sha}"`,
  );
  process.exit(1);
}

const url = `https://raw.githubusercontent.com/hookmyapp/hookmyapp/${sha}/packages/observability/src/errors/manifest.json`;

console.log(`[sync-errors-manifest] fetching ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`[sync-errors-manifest] fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const remote = await res.text();

const isCheck = process.argv.includes('--check');

if (isCheck) {
  const local = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf8') : '';
  if (local.trim() === remote.trim()) {
    console.log(`[sync-errors-manifest] --check: manifest matches pinned SHA ${sha}`);
    process.exit(0);
  }
  console.error(
    `[sync-errors-manifest] --check: manifest DRIFTED from pinned SHA ${sha}.\n  Run \`npm run sync:errors-manifest\` to update src/errors/manifest.json.`,
  );
  process.exit(1);
}

writeFileSync(MANIFEST_PATH, remote);
console.log(
  `[sync-errors-manifest] wrote src/errors/manifest.json from ${sha} (${remote.length} bytes).`,
);
