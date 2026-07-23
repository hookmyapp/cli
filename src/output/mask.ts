import { createHash } from 'node:crypto';

/**
 * Deterministic display mask for the login identity echo (AIT-256).
 *
 * MUST stay byte-for-byte in lockstep with `maskEmail` in the hookmyapp
 * backend (`backend/src/auth/bootstrap/instruction-template.ts`): the
 * bootstrap instruction block renders the Expected-output line masked, and
 * the executing AI compares this CLI's echo against it. Same mask on both
 * sides keeps the paste-into-wrong-AI safety net working while the raw
 * address never appears on screen (screen-recording safety).
 *
 * The trailing `[xxxxxxxx]` is a non-reversible discriminator (first 8 hex
 * of SHA-256 of the normalized address) so two accounts sharing a masked
 * prefix (jo***@g***.com is common) still render distinct echoes. It is a
 * sanity check against accidental wrong-account pastes, not authentication.
 *
 * `--json` output is exempt: machine consumers get the raw email.
 */
export function displayEmail(email: string): string {
  const tag = createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 8);
  const at = email.indexOf('@');
  if (at <= 0) return `*** [${tag}]`;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const tld = lastDot > 0 ? domain.slice(lastDot) : '';
  const domainName = lastDot > 0 ? domain.slice(0, lastDot) : domain;
  return `${local.slice(0, 2)}***@${domainName.charAt(0)}***${tld} [${tag}]`;
}
