import { ValidationError } from '../../output/error.js';

const RELATIVE_PATTERN = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Convert a `--since` / `--until` argument into an ISO-8601 string that the
 * `GET /deliveries` API accepts (its DTO validates with `@IsISO8601()`).
 *
 * Accepts either:
 *   - a relative shorthand `<n>s` / `<n>m` / `<n>h` / `<n>d`, resolved against
 *     `now` and always at or before `now`, or
 *   - an absolute timestamp parseable by `Date` (ISO-8601 etc.).
 *
 * Throws `ValidationError` (exit 2) on anything else — including a relative
 * value so large it overflows the representable `Date` range.
 */
export function parseTimeArg(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  const rel = RELATIVE_PATTERN.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    const resolved = new Date(now.getTime() - amount * UNIT_MS[rel[2]]);
    if (Number.isNaN(resolved.getTime())) {
      throw new ValidationError(
        `Invalid time value: "${value}". Use a relative shorthand (30m, 2h, 7d) ` +
          `or an ISO-8601 timestamp.`,
      );
    }
    return resolved.toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      `Invalid time value: "${value}". Use a relative shorthand (30m, 2h, 7d) ` +
        `or an ISO-8601 timestamp.`,
    );
  }
  return parsed.toISOString();
}
