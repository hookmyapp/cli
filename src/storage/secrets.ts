import { readFileSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCredentialsFile, safeWriteFileSync } from './path.js';

/**
 * Token persistence layer. Default path: OS keychain via @napi-rs/keyring.
 * Fallback path: <config-dir>/credentials.json with mode 0o600.
 *
 * Fallback triggers on ANY of:
 *   - HOOKMYAPP_DISABLE_KEYCHAIN=1 (tests, CI, opt-out)
 *   - @napi-rs/keyring fails to load (native binding not available for this platform-arch)
 *   - keychain operation throws (no daemon, locked, denied)
 *
 * Keychain entries: service="hookmyapp", three accounts:
 *   - "access-token", "refresh-token", "expires-at"
 */

export interface Secrets {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const SERVICE = 'hookmyapp';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EntryClass = new (service: string, account: string) => {
  setPassword(value: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
};

let entryClassCache: EntryClass | null | undefined = undefined;

async function loadEntryClass(): Promise<EntryClass | null> {
  if (entryClassCache !== undefined) return entryClassCache;
  if (process.env.HOOKMYAPP_DISABLE_KEYCHAIN === '1') {
    entryClassCache = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@napi-rs/keyring');
    entryClassCache = mod.Entry as EntryClass;
    return entryClassCache;
  } catch {
    entryClassCache = null;
    return null;
  }
}

export async function writeSecrets(secrets: Secrets): Promise<void> {
  const Entry = await loadEntryClass();
  if (Entry) {
    try {
      new Entry(SERVICE, 'access-token').setPassword(secrets.accessToken);
      new Entry(SERVICE, 'refresh-token').setPassword(secrets.refreshToken);
      new Entry(SERVICE, 'expires-at').setPassword(String(secrets.expiresAt));
      return;
    } catch {
      process.stderr.write(
        `⚠ Keychain unavailable, storing credentials in file at ${getCredentialsFile()} (mode 0o600).\n`,
      );
      // Fall through to file path.
    }
  }
  const path = getCredentialsFile();
  safeWriteFileSync(path, JSON.stringify(secrets, null, 2));
  chmodSync(path, 0o600);
}

export async function readSecrets(): Promise<Secrets | null> {
  const Entry = await loadEntryClass();
  if (Entry) {
    try {
      const access = new Entry(SERVICE, 'access-token').getPassword();
      const refresh = new Entry(SERVICE, 'refresh-token').getPassword();
      const exp = new Entry(SERVICE, 'expires-at').getPassword();
      if (access && refresh && exp) {
        const expiresAt = Number(exp);
        if (Number.isFinite(expiresAt)) {
          return { accessToken: access, refreshToken: refresh, expiresAt };
        }
      }
      // Keychain returned partial/empty — fall through to file path.
    } catch {
      // Fall through to file path.
    }
  }
  const path = getCredentialsFile();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Secrets;
  } catch {
    return null;
  }
}

export async function deleteSecrets(): Promise<void> {
  const Entry = await loadEntryClass();
  if (Entry) {
    try {
      new Entry(SERVICE, 'access-token').deletePassword();
      new Entry(SERVICE, 'refresh-token').deletePassword();
      new Entry(SERVICE, 'expires-at').deletePassword();
    } catch {
      // Best effort; fall through to file deletion.
    }
  }
  const path = getCredentialsFile();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone; ignore.
    }
  }
}

// Test-only: reset the entry-class cache between cases so toggling
// HOOKMYAPP_DISABLE_KEYCHAIN inside a single test file behaves predictably.
export function __resetForTests(): void {
  entryClassCache = undefined;
}

/**
 * Copy-verify-delete migration of credentials.json from a legacy config
 * directory into the canonical secrets store (keychain by default, file
 * fallback if keychain unavailable).
 *
 * Order of operations:
 *   1. Read legacy credentials.json. If parse fails → leave file alone, return.
 *   2. writeSecrets() to the canonical location.
 *   3. readSecrets() to verify the round-trip.
 *   4. ONLY IF verification matches the legacy payload → unlink legacy file.
 *
 * If any step fails, the legacy file is left intact so the user retains a
 * recoverable copy of their credentials.
 */
export async function migrateLegacyCredentials(legacyDir: string): Promise<void> {
  const legacyPath = join(legacyDir, 'credentials.json');
  if (!existsSync(legacyPath)) return;

  let legacy: Secrets;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as Secrets;
  } catch {
    return;
  }
  if (
    typeof legacy?.accessToken !== 'string' ||
    typeof legacy?.refreshToken !== 'string' ||
    typeof legacy?.expiresAt !== 'number'
  ) {
    return;
  }

  await writeSecrets(legacy);
  const verify = await readSecrets();
  if (
    verify?.accessToken === legacy.accessToken &&
    verify?.refreshToken === legacy.refreshToken &&
    verify?.expiresAt === legacy.expiresAt
  ) {
    try {
      unlinkSync(legacyPath);
    } catch {
      // Already gone; ignore.
    }
  }
}
