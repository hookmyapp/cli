// Phase 125 Plan 01 Task 2 — CLI-side event-manifest drift test.
//
// Guards the CLI-LOCAL side of the manifest mirror:
//   1. The JSON manifest parses with `version: '1'` + 24 unique event names.
//   2. Every name in the JSON manifest appears in the runtime
//      `EVENT_NAMES_RUNTIME` array exported from `src/analytics/events.ts`.
//   3. Every name in the runtime array appears in the JSON manifest.
//
// The monorepo-side byte-equality check lives in
// `packages/observability/src/analytics/__tests__/manifest-drift.spec.ts` —
// together the two sides guarantee that editing one file without mirroring
// the other fails CI in at least one repo.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_NAMES_RUNTIME } from '../analytics/events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

interface Manifest {
  version: string;
  events: Array<{ name: string; properties: string[] }>;
}

const manifestPath = resolve(__dirname, '../analytics/events.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

describe('CLI events.manifest.json structural contract', () => {
  it('parses as { version, events[] }', () => {
    expect(manifest.version).toBe('1');
    expect(Array.isArray(manifest.events)).toBe(true);
  });

  it('contains exactly 24 events', () => {
    expect(manifest.events).toHaveLength(24);
  });

  it('event names are unique', () => {
    const names = manifest.events.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('CLI manifest ↔ runtime registry drift', () => {
  it('runtime registry has exactly 24 names', () => {
    expect(EVENT_NAMES_RUNTIME).toHaveLength(24);
  });

  it('every manifest event name is present in EVENT_NAMES_RUNTIME', () => {
    const runtime = new Set<string>(EVENT_NAMES_RUNTIME);
    const missing = manifest.events
      .map((e) => e.name)
      .filter((n) => !runtime.has(n));
    expect(missing).toEqual([]);
  });

  it('every EVENT_NAMES_RUNTIME entry is present in manifest', () => {
    const manifestNames = new Set<string>(manifest.events.map((e) => e.name));
    const missing = EVENT_NAMES_RUNTIME.filter((n) => !manifestNames.has(n));
    expect(missing).toEqual([]);
  });
});
