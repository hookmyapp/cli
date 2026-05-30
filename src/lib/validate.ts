import { ValidationError } from '../output/error.js';

/**
 * Validate a `--port` option value into a TCP port (1..65535). Throws
 * ValidationError (exit 2) on non-integer, partial, or out-of-range input.
 *
 * Previously the listen commands used `parseInt(v, 10)`, which silently
 * accepted `3000abc` as 3000 and turned `abc` into NaN — both then flowed into
 * tunnel/proxy setup. Reject locally instead, mirroring the sandbox-logs
 * `--limit` validator.
 */
export function parsePortArg(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ValidationError(
      `--port must be an integer between 1 and 65535 (got "${raw}").`,
    );
  }
  return n;
}
