import { getEffectiveApiUrl } from '../config/env-profiles.js';
import { NetworkError } from '../output/error.js';
import { timedFetch } from './timed-fetch.js';
import { mapApiError, isNetworkFailure } from './client.js';

// Re-declared wire DTOs (the backend is never imported). Keep field names in
// lockstep with the auth.md endpoints; integration drift is caught by tests.
export interface ClaimInitiated {
  registrationId: string; // UUID
  expiresAt: string; // ISO timestamp
}

export interface AgentCredentialResponse {
  accessToken: string; // opaque "hmok_…" Bearer token (the ac_ id is the credential's public row id, not the secret)
  tokenType: string; // "Bearer"
  scopes: string[];
  credentialPublicId: string;
  expiresAt?: string;
  orgId?: string;
  /** The org this credential is locked to. It cannot be re-scoped later. */
  organizationPublicId?: string;
  /** Every org the user belongs to, so a multi-org user can re-claim elsewhere. */
  organizations?: Array<{ publicId: string; name: string }>;
}

// Auth requests must not hang an agent or CI job forever; bound every call.
async function boundedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await timedFetch(url, init);
  } catch (err) {
    // A timeout abort and any transport failure both mean the same thing to
    // the user: NetworkError, exit 5.
    if (isNetworkFailure(err)) throw new NetworkError();
    throw err;
  }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await boundedFetch(`${getEffectiveApiUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await mapApiError(res);
  return res.json();
}

/** Full scope vocabulary advertised by the backend (drift-free default). */
export async function fetchSupportedScopes(): Promise<string[]> {
  const res = await boundedFetch(
    `${getEffectiveApiUrl()}/.well-known/oauth-protected-resource`,
    { method: 'GET' },
  );
  if (!res.ok) throw await mapApiError(res);
  const body = (await res.json()) as { scopes_supported?: string[] };
  return Array.isArray(body.scopes_supported) ? body.scopes_supported : [];
}

export async function initiateClaim(input: { email: string; scopes: string[] }): Promise<ClaimInitiated> {
  const data = (await postJson('/agent/auth/claim', input)) as ClaimInitiated;
  return { registrationId: data.registrationId, expiresAt: data.expiresAt };
}

export async function completeClaim(input: {
  registrationId: string;
  otp: string;
  organizationPublicId?: string;
}): Promise<AgentCredentialResponse> {
  return (await postJson('/agent/auth/claim/complete', input)) as AgentCredentialResponse;
}
