import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = join(homedir(), '.hookmyapp');
const CREDS_FILE = join(CONFIG_DIR, 'credentials.json');

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  chmodSync(CREDS_FILE, 0o600);
}

export function readCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteCredentials(): void {
  try {
    unlinkSync(CREDS_FILE);
  } catch {
    // Ignore if file doesn't exist
  }
}
