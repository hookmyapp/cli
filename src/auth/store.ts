import { readFileSync } from 'node:fs';
import { getConfigFile } from '../storage/path.js';
import { AuthError } from '../output/error.js';
import { API_KEY_ENV_VAR } from '../config/env-vars.js';
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

/**
 * Build a credential from HOOKMYAPP_API_KEY, or null when the variable is
 * unset/empty.
 *
 * Shaped as `kind: 'agent'` on purpose: an org API key is exactly what
 * `hookmyapp credentials create` persists, so every existing agent-credential
 * path (no refresh, no rescope, bearer sent verbatim) applies unchanged.
 *
 * Accepted prefixes mirror the backend's `isAgentToken` — `hmok_` is the
 * current mint, `ac_` is legacy and still resolves server-side. Rejecting
 * `ac_` here would fail keys the API accepts.
 *
 * Throws rather than returning null on a malformed value: a set-but-wrong
 * variable is a configuration mistake, and silently falling through to
 * "Not logged in. Run: hookmyapp login" hides where the bad key came from.
 */
export function readEnvCredential(): Credentials | null {
  const raw = process.env[API_KEY_ENV_VAR]?.trim();
  if (!raw) return null;
  if (!raw.startsWith('hmok_') && !raw.startsWith('ac_')) {
    throw new AuthError(
      `${API_KEY_ENV_VAR} is not a valid API key (expected it to start with "hmok_"). ` +
        `Fix or unset the variable, then retry. Mint a key with: hookmyapp credentials create`,
    );
  }
  return {
    accessToken: raw,
    refreshToken: '',
    expiresAt: 0,
    kind: 'agent',
    source: 'env',
  };
}

/**
 * Resolve the credential every authenticated code path uses.
 *
 * Precedence: HOOKMYAPP_API_KEY beats the stored credential, matching gh
 * (GH_TOKEN), aws, vercel and stripe — an explicitly exported key is the more
 * deliberate signal, and the reverse order silently ignores the key an agent
 * or CI job was handed. The override is reported by `doctor`, and `login`
 * refuses to run while the variable is set, so it is never invisible.
 *
 * `login`/`logout` deliberately bypass this and use readSecrets() directly:
 * they manage the stored credential and must not act on the environment.
 */
export async function readCredentials(): Promise<Credentials | null> {
  return readEnvCredential() ?? (await readSecrets());
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
