/**
 * Names of the environment variables the CLI reads for credentials and
 * workspace selection. Kept in a leaf module (no imports) so consumers can
 * pull the name without dragging in the auth store — several test suites
 * mock `auth/store.js` wholesale, and a constant exported from there would
 * break every one of them.
 */
export const API_KEY_ENV_VAR = 'HOOKMYAPP_API_KEY';
export const WORKSPACE_ENV_VAR = 'HOOKMYAPP_WORKSPACE_ID';
