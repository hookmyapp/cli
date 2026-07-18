import {
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { getCredentialsFile, safeWriteFileSync } from './path.js';

/**
 * Token persistence: plain JSON file at <config-dir>/credentials.json with
 * mode 0o600 (owner read/write only). Same security model as `gh`,
 * `vercel`, `firebase`, `netlify`, `heroku` and every other major
 * Node-distributed CLI.
 *
 * Earlier 0.11.0 design tried OS keychain via @napi-rs/keyring; it was
 * removed because non-signed Node binaries trigger user prompts on every
 * fresh install (different binary path = different keychain ACL), which
 * is unacceptable UX for a dev tool.
 */

export interface Secrets {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Credential kind. Undefined = legacy WorkOS session (device-code / bootstrap). */
  kind?: 'workos' | 'agent';
  /** Agent credentials only: the ac_ credential's public id (for revoke). */
  credentialPublicId?: string;
  /** Agent credentials only: scopes granted at issue time. */
  scopes?: string[];
}

/** True for an auth.md-issued org-scoped agent credential (no refresh token). */
export function isAgentCredential(creds: Secrets): boolean {
  return creds.kind === 'agent';
}

export async function writeSecrets(secrets: Secrets): Promise<void> {
  const path = getCredentialsFile();
  safeWriteFileSync(path, JSON.stringify(secrets, null, 2));
  chmodSync(path, 0o600);
}

export async function readSecrets(): Promise<Secrets | null> {
  const path = getCredentialsFile();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Secrets;
  } catch {
    return null;
  }
}

export async function deleteSecrets(): Promise<void> {
  const path = getCredentialsFile();
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone; ignore.
    }
  }
}

/**
 * Copy-verify-delete migration of credentials.json from a legacy config
 * directory into the canonical config dir. Idempotent.
 *
 * Order of operations:
 *   1. Read legacy credentials.json. If parse fails → leave file alone, return.
 *   2. writeSecrets() to the canonical location.
 *   3. readSecrets() to verify the round-trip.
 *   4. ONLY IF verification matches the legacy payload → unlink legacy file.
 *
 * If any step fails, the legacy file is left intact so the user retains a
 * recoverable copy.
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
