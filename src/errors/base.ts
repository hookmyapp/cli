// Phase 123 Plan 10 — AppError base class (mirrored from monorepo).
//
// Source of truth is `packages/observability/src/errors/base.ts` in the
// hookmyapp monorepo. The CLI is a separate public repo (github.com/hookmyapp/cli)
// and cannot workspace-link to `@hookmyapp/observability`, so the taxonomy
// is mirrored here and kept in sync via `src/errors/manifest.json` + a drift
// test (`src/__tests__/errors-manifest.test.ts`) + the sync script at
// `scripts/sync-errors-manifest.mjs`.
//
// Severity is a STATIC readonly property on each subclass. The class selection
// IS the severity decision — no per-throw judgment.
//
// Phase 108's CLI exit-code hierarchy (0–6) is preserved via `exitCodeFor()`
// in `src/output/error.ts`. Class-to-exit-code mapping:
//   AuthError        → 4
//   PermissionError  → 3
//   ValidationError  → 2
//   ConflictError    → 6
//   NetworkError     → 5
//   everything else  → 1

export type Severity = 'sev1' | 'sev2' | 'sev3';
export type SentryLevel = 'fatal' | 'error' | 'warning';

export const SEVERITY_TO_LEVEL: Record<Severity, SentryLevel> = {
  sev1: 'fatal',
  sev2: 'error',
  sev3: 'warning',
};

export function severityToLevel(s: Severity): SentryLevel {
  return SEVERITY_TO_LEVEL[s];
}

/**
 * Abstract base class. All thrown errors in CLI production code MUST be an
 * instance of a subclass of `AppError`.
 *
 * Static `severity` is the taxonomy decision. Static `httpStatus` is set on
 * classes that map to a specific HTTP response (used by `mapApiError` to
 * preserve the API's status on thrown errors).
 *
 * The instance `severity` + `sentryLevel` getters bridge back to the static
 * properties so callers can `err.severity` without a class cast.
 */
export abstract class AppError extends Error {
  static readonly severity: Severity;
  static readonly httpStatus?: number;

  public readonly code: string;
  public readonly details: Record<string, unknown>;
  public readonly userMessage: string;

  constructor(args: {
    message: string;
    code: string;
    details?: Record<string, unknown>;
    userMessage?: string;
  }) {
    super(args.message);
    this.name = new.target.name;
    this.code = args.code;
    this.details = args.details ?? {};
    // userMessage is what the CLI prints to stderr. Default to `message` so
    // every AppError has a human-readable surface without extra plumbing.
    this.userMessage = args.userMessage ?? args.message;
  }

  get severity(): Severity {
    return (this.constructor as typeof AppError).severity;
  }

  get sentryLevel(): SentryLevel {
    return SEVERITY_TO_LEVEL[this.severity];
  }

  /**
   * Back-compat: the pre-Phase-123 CLI error hierarchy exposed `.statusCode`
   * on every subclass. `AppError.httpStatus` is static; this instance getter
   * bridges to it so existing callers (`output/error.ts::outputError`,
   * `outputError` JSON format) continue to work.
   */
  get statusCode(): number | undefined {
    return (this.constructor as typeof AppError).httpStatus;
  }
}
