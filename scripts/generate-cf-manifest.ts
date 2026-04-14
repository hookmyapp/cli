#!/usr/bin/env tsx
/**
 * Helper: regenerate CLOUDFLARED_SHA256 manifest entries for a given version.
 *
 * Usage:
 *   npx tsx scripts/generate-cf-manifest.ts [version]
 *
 * Default version: 2026.3.0 (keep in sync with binary.ts CLOUDFLARED_VERSION).
 *
 * Paste the printed block into src/commands/sandbox-listen/binary.ts
 * CLOUDFLARED_SHA256 at each version bump.
 */
import { createHash } from 'node:crypto';

const VERSION = process.argv[2] ?? '2026.3.0';

const ASSETS: Array<[string, string]> = [
  ['darwin-arm64.tgz', 'cloudflared-darwin-arm64.tgz'],
  ['darwin-amd64.tgz', 'cloudflared-darwin-amd64.tgz'],
  ['linux-arm64', 'cloudflared-linux-arm64'],
  ['linux-amd64', 'cloudflared-linux-amd64'],
  ['windows-amd64.exe', 'cloudflared-windows-amd64.exe'],
];

console.log(`// Regenerated for cloudflared ${VERSION}`);
console.log('export const CLOUDFLARED_SHA256: Record<string, string> = {');

for (const [key, filename] of ASSETS) {
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  // ${key}: HTTP ${res.status} fetching ${url}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  const padding = ' '.repeat(Math.max(1, 20 - key.length));
  console.log(`  '${key}':${padding}'${sha}',`);
}

console.log('};');
