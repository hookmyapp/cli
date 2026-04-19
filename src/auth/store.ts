import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// HOOKMYAPP_CONFIG_DIR lets tests (and power users) redirect config away from
// the real $HOME/.hookmyapp dir. Resolved on each call so vitest setup files
// that set the env var at process start are honored even if this module was
// imported first.
function configDir(): string {
  return process.env.HOOKMYAPP_CONFIG_DIR ?? join(homedir(), '.hookmyapp');
}
function credsFile(): string {
  return join(configDir(), 'credentials.json');
}
function workspaceConfigFile(): string {
  return join(configDir(), 'config.json');
}

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(credsFile(), JSON.stringify(creds, null, 2));
  chmodSync(credsFile(), 0o600);
}

export function readCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(credsFile(), 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteCredentials(): void {
  try {
    unlinkSync(credsFile());
  } catch {
    // Ignore if file doesn't exist
  }
}

export interface PriorIdentity {
  email: string;
  workspaceSlug: string;
}

/**
 * Phase 122: read-only peek at persisted identity. Returns null if no
 * credentials OR no active workspace OR JWT has no email claim. Makes NO
 * network calls — purely file reads + base64 decode. Used by the
 * bootstrap-code flow to compute the "was:" diff BEFORE overwriting
 * credentials.
 *
 * Reads `config.json` directly (not via `commands/workspace.readWorkspaceConfig`)
 * to avoid a circular import: store.ts → workspace.ts → api/client.ts → store.ts.
 * Both modules share the same on-disk format; this duplicates ~5 lines of
 * JSON parse but keeps the dep graph acyclic.
 */
export function peekIdentity(): PriorIdentity | null {
  const creds = readCredentials();
  if (!creds) return null;
  try {
    const payloadB64 = creds.accessToken.split('.')[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64').toString(),
    ) as Record<string, unknown>;
    const email = typeof payload?.email === 'string' ? payload.email : null;
    if (!email) return null;
    // Read workspace slug directly from config.json — same shape as
    // commands/workspace.readWorkspaceConfig, but without the cycle risk.
    let activeWorkspaceSlug: string | undefined;
    try {
      const cfg = JSON.parse(
        readFileSync(workspaceConfigFile(), 'utf-8'),
      ) as { activeWorkspaceSlug?: string };
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
