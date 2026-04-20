// Phase 123 Plan 10 — single entry point for the CLI's AppError taxonomy.
//
// This barrel re-exports classes from two sources:
//
//   - `base.ts` — the `AppError` abstract base + severity types/helpers. These
//     are CLI-repo local mirrors of `packages/observability/src/errors/base.ts`
//     in the monorepo. Kept in sync via `src/errors/manifest.json` + the drift
//     test below + `scripts/sync-errors-manifest.mjs`.
//
//   - `../output/error.ts` — the concrete CLI AppError subclasses
//     (UserBlockingError, ValidationError, AuthError, …). They layer on top of
//     `CliError` (Phase 108 legacy base) so that `instanceof CliError`
//     invariants from Phase 108 code paths AND `instanceof AppError`
//     invariants from Phase 123 code paths hold simultaneously.
//
// The drift test (`__tests__/errors-manifest.test.ts`) enumerates the
// AppError subclasses in `../output/error.ts` and cross-checks each against
// `manifest.json` (severity + httpStatus). CLI-only classes (NetworkError,
// ApiError, SessionWindowError) are allowlisted in the test.
export {
  AppError,
  SEVERITY_TO_LEVEL,
  severityToLevel,
  type Severity,
  type SentryLevel,
} from './base.js';

// Re-export the concrete CLI-side AppError subclasses from output/error.ts.
// This keeps the legacy "output/error" import path working AND gives new code
// a canonical single-barrel (errors/index) to import from.
export {
  CliError,
  UserBlockingError,
  ConfigurationError,
  UnexpectedError,
  ValidationError,
  AuthError,
  PermissionError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  UserFacingError,
  NetworkError,
  ApiError,
  SessionWindowError,
  exitCodeFor,
} from '../output/error.js';
