import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Single source of truth for the CLI's config directory.
 *
 * Resolution order (first match wins):
 *   1. HOOKMYAPP_CONFIG_DIR env var (existing escape hatch — tests, sandbox
 *      users, project-local overrides).
 *   2. XDG_CONFIG_HOME/hookmyapp (XDG Base Directory Spec).
 *   3. ~/.config/hookmyapp (XDG default).
 *
 * Resolved per-call so tests that set env vars after module import are
 * honored.
 */
export function getConfigDir(): string {
  if (process.env.HOOKMYAPP_CONFIG_DIR) return process.env.HOOKMYAPP_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, 'hookmyapp');
  return join(homedir(), '.config', 'hookmyapp');
}

/** The legacy dotdir we migrate FROM. Always at $HOME/.hookmyapp regardless of XDG settings. */
export function getLegacyConfigDir(): string {
  return join(homedir(), '.hookmyapp');
}

/** Path to config.json inside the resolved config dir. */
export function getConfigFile(): string {
  return join(getConfigDir(), 'config.json');
}

/** Path to credentials.json inside the resolved config dir (file fallback only). */
export function getCredentialsFile(): string {
  return join(getConfigDir(), 'credentials.json');
}
