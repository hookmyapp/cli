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
