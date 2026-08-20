/**
 * Name of the environment variable the CLI reads for credentials. Kept in a leaf module (no imports) so consumers can
 * pull the name without dragging in the auth store — several test suites
 * mock `auth/store.js` wholesale, and a constant exported from there would
 * break every one of them.
 */
export const API_KEY_ENV_VAR = 'HOOKMYAPP_API_KEY';

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

/**
 * The active org API key from the environment, normalized ('' when unset).
 * Every caller must go through this: `HOOKMYAPP_API_KEY='""'` strips to empty,
 * so a raw `process.env[...]` truthiness test would refuse a login (or claim a
 * key is active) when no credential exists at all.
 */
export function envApiKey(): string {
  return stripEnvQuotes(process.env[API_KEY_ENV_VAR]?.trim() ?? '');
}
