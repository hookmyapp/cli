// Phase 123 Plan 10 — CLI error surface.
//
// This file previously defined a standalone `CliError` hierarchy (Phase 108).
// It now layers the AppError taxonomy from `src/errors/` UNDER the existing
// `CliError` base class, preserving two invariants simultaneously:
//   1. `err instanceof CliError` — Phase 108 code paths (sandbox-listen/picker,
//      sandbox-listen/binary, index.ts main(), api-403-handler.spec.ts) keep
//      working.
//   2. `err instanceof AppError` — new Phase 123 code + Sentry `captureError`
//      path see typed AppError subclasses with severity tagging.
//
// `CliError` is a concrete subclass of `AppError` (sev3 default — a safe
// back-compat tier: user-facing 4xx). Every CLI-specific class
// (AuthError/PermissionError/ValidationError/…) extends `CliError`, which in
// turn extends `AppError`. This gives every instance both parentages via the
// prototype chain.
//
// Historical call surface preserved:
//   - `new AuthError('msg')` (or `new AuthError()` with default)
//   - `new PermissionError(activeWorkspaceSlug)`
//   - `new NetworkError()` / `new NetworkError('msg')`
//   - `new ApiError(message, statusCode)`
//   - `new ValidationError(message)`
//   - `new ConflictError(message, code?)`
//   - `new SessionWindowError(message)`
//
// Instances still carry `.userMessage`, `.code`, `.statusCode`, `.exitCode` so
// the `outputError()` helper keeps working without caller changes.
//
// Phase 108 exit-code contract:
//   AuthError        → 4
//   PermissionError  → 3
//   ValidationError  → 2
//   ConflictError    → 6
//   NetworkError     → 5
//   RateLimitError   → 6   (historically flowed through ConflictError)
//   SessionWindowError / UserBlockingError / UnexpectedError / CliError → 1
import { AppError } from '../errors/base.js';
import { cliCommandPrefix } from './cli-self.js';

// Re-export AppError so new code paths can import the canonical name from
// this module (keeping a single import location for legacy + new callers).
export { AppError };
export type { Severity, SentryLevel } from '../errors/base.js';
export { SEVERITY_TO_LEVEL, severityToLevel } from '../errors/base.js';

/**
 * Phase 108 legacy base class. Now a concrete subclass of `AppError` so that:
 *
 *   1. `instanceof CliError` guards continue to work (sandbox-listen picker /
 *      binary / index.ts main() all use this).
 *   2. The historical `new CliError(userMessage, code, statusCode?)`
 *      positional-arg constructor keeps working.
 *   3. Every CLI-specific subclass below extends `CliError`, which extends
 *      `AppError` — instances satisfy `instanceof CliError` AND
 *      `instanceof AppError` simultaneously.
 *
 * Default severity is `sev3` (user-facing). Subclasses override `severity` as
 * needed (UserBlockingError → sev1, UnexpectedError → sev2, …).
 */
export class CliError extends AppError {
  // Typed as the broad `Severity` union (not a narrowed `'sev3'` literal) so
  // that subclasses can override with `'sev1'` / `'sev2'` without tripping
  // TS2417 `incorrectly extends base class static side`. The runtime default
  // stays `'sev3'` — a safe, back-compat user-facing tier.
  static override readonly severity: 'sev1' | 'sev2' | 'sev3' = 'sev3';
  public exitCode: number = 1;

  constructor(userMessage: string, code: string, statusCode?: number) {
    super({ message: userMessage, code });
    if (statusCode !== undefined) {
      Object.defineProperty(this, 'statusCode', {
        value: statusCode,
        writable: false,
        configurable: true,
      });
    }
  }
}

// --- SEV1 ---

export class UserBlockingError extends CliError {
  static readonly severity = 'sev1' as const;
  static readonly httpStatus = 500;
  constructor(message: string, code = 'USER_BLOCKED') {
    super(message, code);
    this.exitCode = 1;
  }
}

export class ConfigurationError extends CliError {
  static readonly severity = 'sev1' as const;
  static readonly httpStatus = 500;
  constructor(message: string, code = 'CONFIG_ERROR') {
    super(message, code);
    this.exitCode = 1;
  }
}

// --- SEV2 ---

export class UnexpectedError extends CliError {
  static readonly severity = 'sev2' as const;
  static readonly httpStatus = 500;
  constructor(message: string, code = 'UNKNOWN_ERROR') {
    super(message, code);
    this.exitCode = 1;
  }
}

// --- SEV3 (monorepo-manifest subset) ---

export class ValidationError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 400;
  constructor(message: string, code = 'VALIDATION_ERROR') {
    super(message, code);
    this.exitCode = 2;
  }
}

export class AuthError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 401;
  constructor(message: string = `Session expired. Run: ${cliCommandPrefix()} login`) {
    super(message, 'AUTH_REQUIRED', 401);
    this.exitCode = 4;
  }
}

export class PermissionError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 403;
  constructor(activeWorkspaceSlug: string) {
    super(
      `This action requires workspace admin permission.\n\n` +
        `Active workspace: ${activeWorkspaceSlug}\n\n` +
        `If you should have admin access, try:\n` +
        `  ${cliCommandPrefix()} login          # refresh your session\n` +
        `  ${cliCommandPrefix()} workspace list # see all your workspaces and roles\n\n` +
        `Otherwise contact your workspace admin.`,
      'PERMISSION_DENIED',
      403,
    );
    this.exitCode = 3;
  }
}

export class NotFoundError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 404;
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, code, 404);
    this.exitCode = 1;
  }
}

export class ConflictError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 409;
  constructor(message: string, code: string = 'CONFLICT') {
    super(message, code, 409);
    this.exitCode = 6;
  }
}

export class RateLimitError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 429;
  constructor(
    message: string = 'Rate limit exceeded. Wait a minute and retry.',
    code = 'RATE_LIMITED',
  ) {
    super(message, code, 429);
    this.exitCode = 6;
  }
}

export class UserFacingError extends CliError {
  static readonly severity = 'sev3' as const;
  constructor(message: string, code = 'USER_FACING_ERROR') {
    super(message, code);
    this.exitCode = 1;
  }
}

// --- CLI-only SEV3 ---

export class NetworkError extends CliError {
  static readonly severity = 'sev3' as const;
  constructor(
    message: string = 'Could not connect to HookMyApp API. Check your internet connection or try again later.',
  ) {
    super(message, 'NETWORK_ERROR');
    this.exitCode = 5;
  }
}

export class ApiError extends CliError {
  static readonly severity = 'sev3' as const;
  constructor(message: string, statusCode: number) {
    const code = statusCode >= 500 ? 'SERVER_ERROR' : 'API_ERROR';
    super(message, code, statusCode);
    this.exitCode = 1;
  }
}

export class SessionWindowError extends CliError {
  static readonly severity = 'sev3' as const;
  static readonly httpStatus = 403;
  constructor(message: string) {
    super(message, 'SESSION_WINDOW_CLOSED', 403);
    this.exitCode = 1;
  }
}

/**
 * Map any thrown value to a CLI exit code. Phase 108's exit-code contract is
 * preserved via a lookup on the subclass identity:
 *   AuthError → 4, PermissionError → 3, ValidationError → 2, ConflictError → 6,
 *   RateLimitError → 6, NetworkError → 5, everything else → 1.
 *
 * `main()` in `src/index.ts` calls this to derive the final `process.exit(n)`.
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof AuthError) return 4;
  if (err instanceof PermissionError) return 3;
  if (err instanceof ValidationError) return 2;
  if (err instanceof ConflictError) return 6;
  if (err instanceof RateLimitError) return 6;
  if (err instanceof NetworkError) return 5;
  if (err instanceof CliError) {
    // Prefer the per-instance exitCode override (sandbox-listen picker/binary,
    // Phase 122 bootstrap-code API errors set this explicitly).
    return err.exitCode ?? 1;
  }
  return 1;
}

export function outputError(error: CliError, opts: { human?: boolean }): void {
  if (opts.human) {
    process.stderr.write(`Error: ${error.userMessage}\n`);
  } else {
    const obj: Record<string, unknown> = {
      error: error.userMessage,
      code: error.code,
    };
    if (error.statusCode !== undefined) {
      obj.status = error.statusCode;
    }
    process.stderr.write(JSON.stringify(obj) + '\n');
  }
}
