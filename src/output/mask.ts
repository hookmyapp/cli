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
 * Collision resistance comes from the workspace publicId rendered next to
 * the workspace name in the same echo line (random id, customer-visible,
 * zero PII) — NOT from an email hash, which would leak an enumerable
 * identifier onto public surfaces.
 *
 * `--json` output is exempt: machine consumers get the raw email.
 */
export function displayEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const tld = lastDot > 0 ? domain.slice(lastDot) : '';
  const domainName = lastDot > 0 ? domain.slice(0, lastDot) : domain;
  return `${local.slice(0, 2)}***@${domainName.charAt(0)}***${tld}`;
}
