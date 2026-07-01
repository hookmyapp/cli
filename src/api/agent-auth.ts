import { getEffectiveApiUrl } from '../config/env-profiles.js';
import { NetworkError } from '../output/error.js';
import { mapApiError, isNetworkFailure } from './client.js';

// Re-declared wire DTOs (the backend is never imported). Keep field names in
// lockstep with the auth.md endpoints; integration drift is caught by tests.
export interface ClaimInitiated {
  registrationId: string; // UUID
  expiresAt: string; // ISO timestamp
}

export interface AgentCredentialResponse {
  accessToken: string; // "ac_…" Bearer credential
  tokenType: string; // "Bearer"
  scopes: string[];
  credentialPublicId: string;
  expiresAt?: string;
  orgId?: string;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const url = `${getEffectiveApiUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (isNetworkFailure(err)) throw new NetworkError();
    throw err;
  }
  if (!res.ok) throw await mapApiError(res);
  return res.json();
}

/** Full scope vocabulary advertised by the backend (drift-free default). */
export async function fetchSupportedScopes(): Promise<string[]> {
  const url = `${getEffectiveApiUrl()}/.well-known/oauth-protected-resource`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (err) {
    if (isNetworkFailure(err)) throw new NetworkError();
    throw err;
  }
  if (!res.ok) throw await mapApiError(res);
  const body = (await res.json()) as { scopes_supported?: string[] };
  return Array.isArray(body.scopes_supported) ? body.scopes_supported : [];
}

export async function initiateClaim(input: { email: string; scopes: string[] }): Promise<ClaimInitiated> {
  const data = (await postJson('/agent/auth/claim', input)) as ClaimInitiated;
  return { registrationId: data.registrationId, expiresAt: data.expiresAt };
}

export async function completeClaim(input: { registrationId: string; otp: string }): Promise<AgentCredentialResponse> {
  return (await postJson('/agent/auth/claim/complete', input)) as AgentCredentialResponse;
}
