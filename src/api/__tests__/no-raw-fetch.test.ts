import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AIT-540 recurrence guard.
 *
 * The 21 GB incident was one unbounded `fetch`. The fix is only durable if the
 * next raw `fetch` fails a test instead of shipping, so this pins the rule the
 * codebase now follows: every outbound request goes through
 * `api/timed-fetch.ts`, which is the one place allowed to call `fetch`.
 */

const SRC = join(fileURLToPath(new URL('../../', import.meta.url)));

/** The only file allowed to call fetch, plus the detached child in
 *  notifications-nudge.ts, whose request lives in a string executed by
 *  `node -e` in another process and cannot import anything. */
const ALLOWED = new Set(['api/timed-fetch.ts', 'notifications-nudge.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(full);
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) {
      return [];
    }
    return [full];
  });
}

describe('every outbound request is bounded (AIT-540)', () => {
  it('no source file calls fetch() directly', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.has(relative(SRC, file)))
      // `await fetch(` / `= fetch(` / `return fetch(` — a call, not the word in
      // a comment or an identifier like `timedFetch(`.
      .filter((file) => /(?:await|=|return|[^a-zA-Z])\s*\bfetch\(/.test(stripComments(readFileSync(file, 'utf-8'))))
      .map((file) => relative(SRC, file));

    expect(
      offenders,
      'Use timedFetch / connectTimedFetch from api/timed-fetch.ts — a raw fetch has no timeout and can hang the CLI forever.',
    ).toEqual([]);
  });
});

/** Comments legitimately mention fetch(); only real calls count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
