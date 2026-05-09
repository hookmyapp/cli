import { readFileSync } from 'node:fs';
import { getConfigFile } from '../storage/path.js';
import {
  writeSecrets,
  readSecrets,
  deleteSecrets,
  type Secrets,
} from '../storage/secrets.js';

/**
 * Re-export of the canonical Secrets shape so callers keep importing
 * `Credentials` from this file.
 */
export type Credentials = Secrets;

export async function saveCredentials(creds: Credentials): Promise<void> {
  await writeSecrets(creds);
}

export async function readCredentials(): Promise<Credentials | null> {
  return readSecrets();
}

export async function deleteCredentials(): Promise<void> {
  await deleteSecrets();
}

export interface PriorIdentity {
  email: string;
  workspaceSlug: string;
}

/**
 * Read-only peek at persisted identity. Returns null if no credentials OR
 * no active workspace OR JWT has no email claim. Makes NO network calls.
 */
export async function peekIdentity(): Promise<PriorIdentity | null> {
  const creds = await readCredentials();
  if (!creds) return null;
  try {
    const payloadB64 = creds.accessToken.split('.')[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64').toString(),
    ) as Record<string, unknown>;
    const email = typeof payload?.email === 'string' ? payload.email : null;
    if (!email) return null;
    let activeWorkspaceSlug: string | undefined;
    try {
      const cfg = JSON.parse(readFileSync(getConfigFile(), 'utf-8')) as {
        activeWorkspaceSlug?: string;
      };
      activeWorkspaceSlug =
        typeof cfg?.activeWorkspaceSlug === 'string' ? cfg.activeWorkspaceSlug : undefined;
    } catch {
      return null;
    }
    if (!activeWorkspaceSlug) return null;
    return { email, workspaceSlug: activeWorkspaceSlug };
  } catch {
    return null;
  }
}
