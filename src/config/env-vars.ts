/**
 * Names of the environment variables the CLI reads for credentials and
 * workspace selection. Kept in a leaf module (no imports) so consumers can
 * pull the name without dragging in the auth store — several test suites
 * mock `auth/store.js` wholesale, and a constant exported from there would
 * break every one of them.
 */
export const API_KEY_ENV_VAR = 'HOOKMYAPP_API_KEY';
export const WORKSPACE_ENV_VAR = 'HOOKMYAPP_WORKSPACE_ID';

/**
 * Drop one layer of matching surrounding quotes from an env-var value.
 *
 * cmd.exe stores `set VAR="value"` with the quotes included, unlike PowerShell
 * and POSIX shells, so a Windows user following the documented instructions
 * ends up with a value no prefix/shape check would accept.
 */
export function stripEnvQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
