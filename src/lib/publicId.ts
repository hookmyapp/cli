// Local copy of the @hookmyapp/shared publicId alphabet + isValidPublicId
// regex helper. The monorepo source
// (packages/shared/src/publicId.ts) is the canonical definition; this file
// is a verbatim fallback because @hookmyapp/shared is NOT published to npm
// (monorepo-internal workspace package). Keep the alphabet / length /
// prefix list in sync manually on any future changes.
//
// Phase 117 (prefixed public IDs) — the CLI only validates incoming flag
// strings and treats server-returned publicId values as opaque identifiers
// everywhere else. No generation happens on the CLI side.

// prettier-ignore
export const PUBLIC_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const PUBLIC_ID_LENGTH = 8;

/**
 * Locked set of prefixes used across the product. Mirrors
 * PUBLIC_ID_PREFIXES in @hookmyapp/shared.
 */
export const PUBLIC_ID_PREFIXES = ['ws', 'ch', 'usr', 'inv', 'ssn', 'mem'] as const;
export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[number];

/**
 * Narrow runtime type-guard: true iff `value` is a string matching
 * `^{prefix}_[0-9A-Za-z]{PUBLIC_ID_LENGTH}$`. Rejects UUIDs, wrong
 * prefixes, wrong lengths, dashes/underscores in the body, and non-string
 * inputs — exactly mirroring the backend's acceptance contract
 * (backend/src/workspace/workspace.guard.ts + ResolvePublicIdPipe).
 */
export function isValidPublicId(value: unknown, prefix: PublicIdPrefix): boolean {
  if (typeof value !== 'string') return false;
  const re = new RegExp(`^${prefix}_[0-9A-Za-z]{${PUBLIC_ID_LENGTH}}$`);
  return re.test(value);
}

/**
 * True iff `value` matches the canonical UUID shape (any version). Used at
 * CLI surfaces to short-circuit raw-UUID input with a typed ValidationError
 * before round-tripping to the backend. Mirrors the backend's own rejection
 * path so CI scripts see exit 2 locally instead of exit 1 from a 400.
 */
export function isLikelyUuid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
