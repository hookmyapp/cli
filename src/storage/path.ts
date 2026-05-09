import { writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { ConfigWriteForbiddenError } from './errors.js';

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

/**
 * writeFileSync wrapper that catches EPERM/EACCES/EROFS and re-throws as
 * ConfigWriteForbiddenError so callers get the actionable user message.
 * Auto-creates the parent directory (also error-translated).
 */
export function safeWriteFileSync(path: string, data: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
      throw new ConfigWriteForbiddenError(path);
    }
    throw err;
  }
}

/**
 * One-shot migration of config.json from the legacy ~/.hookmyapp/ dir to the
 * XDG-canonical dir. Idempotent — safe to call on every CLI invocation.
 *
 * Cases:
 *   - only old exists  → atomic rename old → new
 *   - only new exists  → no-op
 *   - both exist       → prefer new, warn user, leave old alone
 *   - neither exists   → no-op
 *
 * Credentials migration is handled separately in src/storage/secrets.ts so
 * the keychain write+verify sequence runs only when secrets exist.
 */
export function migrateConfigDirIfNeeded(
  legacyDir: string = getLegacyConfigDir(),
  newDir: string = getConfigDir(),
): void {
  const oldFile = join(legacyDir, 'config.json');
  const newFile = join(newDir, 'config.json');
  const oldExists = existsSync(oldFile);
  const newExists = existsSync(newFile);

  if (!oldExists && !newExists) return;
  if (!oldExists && newExists) return;

  if (oldExists && newExists) {
    process.stderr.write(
      `\n⚠ Both ~/.hookmyapp/config.json and ${newFile} exist.\n` +
        `  Using the new location. Consider manual cleanup of ~/.hookmyapp/.\n\n`,
    );
    return;
  }

  // oldExists && !newExists → migrate.
  mkdirSync(newDir, { recursive: true });
  renameSync(oldFile, newFile);
}
