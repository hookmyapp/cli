/**
 * Returns the user-facing CLI invocation prefix.
 *
 * - When the CLI is launched via `npx` (npm sets `npm_command=exec`),
 *   returns `'npx hookmyapp'` so printed hints are copy-pasteable for users
 *   who haven't installed @gethookmyapp/cli globally.
 * - Otherwise returns `'hookmyapp'`.
 *
 * Use this helper in EVERY printed user-facing string that shows a
 * runnable `hookmyapp <subcommand>` line. Do NOT inline the env detection
 * — that creates drift the next time we add another invocation prefix
 * (e.g. `pnpm dlx`).
 */
export function cliCommandPrefix(): string {
  return process.env.npm_command === 'exec' ? 'npx hookmyapp' : 'hookmyapp';
}
