/**
 * Facebook Pages ships dark: the server refuses new Page connections until
 * the `facebook-enabled` flag is on in production, so the CLI keeps the
 * Facebook surface out of help and pickers until then. Explicit
 * `channels connect facebook`, `sandbox start --type facebook` and the
 * `facebook` command group still work for staging testers.
 *
 * Flip FACEBOOK_PUBLIC to true in the release that goes out with the
 * production flag; HOOKMYAPP_FACEBOOK_PREVIEW=1 shows everything before that.
 */
export const FACEBOOK_PUBLIC = true;

export function facebookVisible(): boolean {
  return FACEBOOK_PUBLIC || process.env.HOOKMYAPP_FACEBOOK_PREVIEW === "1";
}

/** "WhatsApp, Instagram & Facebook" or "WhatsApp & Instagram" for descriptions. */
export function channelKinds(joiner: "&" | "or" = "&"): string {
  return facebookVisible()
    ? `WhatsApp, Instagram ${joiner} Facebook`
    : `WhatsApp ${joiner} Instagram`;
}
