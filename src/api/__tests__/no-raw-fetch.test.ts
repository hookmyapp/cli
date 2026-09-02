import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

/** Windows hands back `api\\timed-fetch.ts`; the allowlist is written in POSIX. */
function relPath(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

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

/**
 * Files whose body reads are deliberately unguarded.
 *
 * `api/client.ts` — mapApiError and parseClientOutdated read the body of an
 * ALREADY-failed response. A stall there loses the detail but keeps the HTTP
 * status, which is the more useful thing to report; promoting it to
 * NetworkError would throw the status away.
 * `notifications-nudge.ts` — the read lives in a string run by `node -e` in a
 * detached child that swallows everything by design.
 */
const BODY_READ_ALLOWED = new Set(['api/client.ts', 'notifications-nudge.ts']);

/** `res.json()` / `res.text()` / `res.arrayBuffer()`, wrapped or not. */
const BODY_READ = /\b(?:res|response)\.(?:json|text|arrayBuffer)\(\)/g;

describe('every outbound request is bounded (AIT-540)', () => {
  it('no source file calls fetch() directly', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.has(relPath(file)))
      // `await fetch(` / `= fetch(` / `return fetch(` — a call, not the word in
      // a comment or an identifier like `timedFetch(`.
      .filter((file) => /(?:await|=|return|[^a-zA-Z])\s*\bfetch\(/.test(stripComments(readFileSync(file, 'utf-8'))))
      .map(relPath);

    expect(
      offenders,
      'Use timedFetch / connectTimedFetch from api/timed-fetch.ts — a raw fetch has no timeout and can hang the CLI forever.',
    ).toEqual([]);
  });

  it('no source file reads a response body without readBody', () => {
    // Bounding the request moved some failures past the fetch catch: headers
    // arrive 2xx and the bytes never do. Codex found four of these one at a
    // time during review, which is what this pins.
    const offenders = sourceFiles(SRC)
      .filter((file) => !BODY_READ_ALLOWED.has(relPath(file)))
      .filter((file) => {
        // Collapse whitespace so a `readBody(` split across lines still counts.
        const flat = stripComments(readFileSync(file, 'utf-8')).replace(/\s+/g, ' ');
        return [...flat.matchAll(BODY_READ)].some(
          (m) => !flat.slice(Math.max(0, m.index - 40), m.index).includes('readBody('),
        );
      })
      .map(relPath);

    expect(
      offenders,
      'Wrap the read in readBody() from api/timed-fetch.ts — a body that stalls after 2xx headers otherwise surfaces as an empty success or a bare UNKNOWN_ERROR.',
    ).toEqual([]);
  });

  it('no readBody has its NetworkError swallowed by the next catch', () => {
    // The third way this bug hid: wrap the read correctly, then discard the
    // error you just raised with a blanket `.catch(() => fallback)`.
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const flat = stripComments(readFileSync(file, 'utf-8')).replace(/\s+/g, ' ');
        return [...flat.matchAll(/readBody\(/g)].some((m) => {
          const after = flat.slice(m.index, m.index + 260);
          const swallow = after.match(/\)\s*\.catch\(/);
          if (swallow?.index === undefined) return false;
          return !after.slice(swallow.index, swallow.index + 160).includes('NetworkError');
        });
      })
      .map(relPath);

    expect(
      offenders,
      'A .catch() after readBody() must re-throw NetworkError — the fallback is for a non-JSON body, not for a dead connection.',
    ).toEqual([]);
  });
});

/** Comments legitimately mention fetch(); only real calls count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
