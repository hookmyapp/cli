// Phase 123 Plan 10 — minimal JWT `sub` decoder.
//
// We can't pull `jose` (or similar) into the CLI just for one field — the
// token is already trusted (we issued it; the refresh flow validates
// signatures at WorkOS). We just need the `sub` claim to pass to
// `Sentry.setUser({ id })`. A single base64url decode of the payload segment
// is enough.
//
// Safe failure: malformed token → empty string → Sentry.setUser skips (the
// observability/sentry.ts caller guards on empty sub).
export function decodeJwtSub(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const payloadB64 = parts[1];
    if (!payloadB64) return '';
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const sub = payload.sub;
    return typeof sub === 'string' ? sub : '';
  } catch {
    return '';
  }
}
