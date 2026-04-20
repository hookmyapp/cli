// Phase 123 Plan 10 — CLI error manifest drift test.
//
// Asserts that every AppError subclass exported from `src/errors/index.ts`
// matches its corresponding entry in `src/errors/manifest.json` (which is
// a mirror of the monorepo's `packages/observability/src/errors/manifest.json`
// kept in sync via `scripts/sync-errors-manifest.mjs`).
//
// The CLI exports a SUBSET of the monorepo manifest (it doesn't use
// DataIntegrityError, SecurityBoundaryError, etc.) — the test only fails on:
//   - A CLI-exported AppError subclass that is missing from the manifest
//   - A CLI-exported AppError subclass whose `severity` or `httpStatus`
//     disagrees with the manifest entry
//
// CLI-specific classes (NetworkError, ApiError, SessionWindowError) are
// allowlisted via `CLI_ONLY_CLASSES` — they're intentionally outside the
// monorepo manifest because the monorepo doesn't use them.
import { describe, it, expect } from 'vitest';
import manifestJson from '../errors/manifest.json' with { type: 'json' };
import * as errorsModule from '../errors/index.js';
import { AppError } from '../errors/base.js';

interface ManifestEntry {
  severity: 'sev1' | 'sev2' | 'sev3';
  httpStatus?: number;
}

const manifest = manifestJson as {
  schemaVersion: number;
  generatedAt: string;
  classes: Record<string, ManifestEntry>;
};

// CLI-specific AppError subclasses that are intentionally NOT in the monorepo
// manifest (they exist only in the CLI surface area).
//
// `CliError` is the Phase 108 legacy base — a concrete class that extends
// `AppError` but has no severity-tier meaning of its own (default sev3). It
// stays in the CLI surface for `instanceof CliError` back-compat (sandbox-listen
// picker/binary, index.ts main()) and is NOT part of the monorepo taxonomy.
const CLI_ONLY_CLASSES = new Set([
  'CliError',
  'NetworkError',
  'ApiError',
  'SessionWindowError',
]);

describe('CLI error manifest drift', () => {
  it('manifest schemaVersion is 1', () => {
    expect(manifest.schemaVersion).toBe(1);
  });

  it('every CLI-exported AppError subclass appears in the manifest (except CLI-only classes)', () => {
    for (const [name, value] of Object.entries(errorsModule)) {
      if (typeof value !== 'function') continue;
      const ctor = value as typeof AppError;
      // Check if ctor is a subclass of AppError (not AppError itself).
      if (!(ctor.prototype instanceof AppError)) continue;
      if (CLI_ONLY_CLASSES.has(name)) continue;
      expect(manifest.classes, `manifest missing AppError subclass: ${name}`).toHaveProperty(name);
    }
  });

  it('every CLI-exported AppError subclass has matching severity + httpStatus in manifest', () => {
    for (const [name, value] of Object.entries(errorsModule)) {
      if (typeof value !== 'function') continue;
      const ctor = value as typeof AppError;
      if (!(ctor.prototype instanceof AppError)) continue;
      if (CLI_ONLY_CLASSES.has(name)) continue;
      const entry = manifest.classes[name];
      expect(entry, `manifest missing entry for ${name}`).toBeDefined();
      expect(ctor.severity, `${name}: severity mismatch`).toBe(entry.severity);
      // httpStatus is optional in the manifest — compare when both sides have it.
      if (entry.httpStatus !== undefined) {
        expect(
          ctor.httpStatus,
          `${name}: httpStatus mismatch (manifest=${entry.httpStatus} class=${ctor.httpStatus})`,
        ).toBe(entry.httpStatus);
      }
    }
  });

  it('CLI-only classes extend AppError (defense against accidental plain-Error throws)', () => {
    // `CliError` is the legacy base itself (concrete subclass of AppError).
    // Every other CLI-only class must extend `AppError` via `CliError`.
    for (const name of ['NetworkError', 'ApiError', 'SessionWindowError']) {
      const ctor = (errorsModule as Record<string, unknown>)[name] as
        | typeof AppError
        | undefined;
      expect(ctor, `CLI-only class missing from exports: ${name}`).toBeDefined();
      expect(
        ctor!.prototype instanceof AppError,
        `${name} must extend AppError`,
      ).toBe(true);
    }
  });

  it('the 15 canonical manifest classes are all present (sanity check on the mirrored JSON)', () => {
    // This test fails if the monorepo manifest is ever sync-fetched in a
    // reduced state. Keep it locked to the Phase 123 Plan 02 shape.
    const names = Object.keys(manifest.classes).sort();
    expect(names).toEqual(
      [
        'AuthError',
        'BackgroundJobError',
        'ConfigurationError',
        'ConflictError',
        'DataIntegrityError',
        'NotFoundError',
        'PaymentStateError',
        'PermissionError',
        'QueueError',
        'RateLimitError',
        'SecurityBoundaryError',
        'UnexpectedError',
        'UserBlockingError',
        'UserFacingError',
        'ValidationError',
      ].sort(),
    );
  });
});
