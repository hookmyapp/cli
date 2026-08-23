import { hostname } from 'node:os';
import { readCredentials, saveCredentials } from './store.js';
import { isAgentCredential } from '../storage/secrets.js';
import { AuthError } from '../output/error.js';

/**
 * The token MCP clients get.
 *
 * The CLI's own session is normally a WorkOS JWT — device-code login and
 * `login --code` both store one, and the CLI needs it for its refresh token
 * and workspace rescoping. But that JWT carries no `aud` claim, and the `/mcp`
 * audience guard rejects anything it cannot pin to this resource, so a coding
 * agent handed the JWT gets a 401 on every tool call (AIT-460).
 *
 * An org credential (`hmok_`) is what `/mcp` accepts. Mint one per machine
 * from the logged-in session and hand THAT to the agents, leaving the CLI's own
 * session untouched. An OTP login already stores an `hmok_`, so those sessions
 * skip the mint entirely.
 *
 * The key is minted lazily — on the first request for MCP headers — so a
 * failure here can never block a login.
 */

/** `POST /agent/credentials` caps the name at 60 characters. */
const NAME_MAX = 60;

/** Stable per-machine name, so a re-login replaces its own key instead of
 *  stacking a new one on the user's API-keys page every time. */
export function credentialName(host = hostname()): string {
  return `${host} (HookMyApp CLI)`.slice(0, NAME_MAX);
}

interface MintedCredential {
  accessToken: string;
  publicId: string;
}

/**
 * Revoke this machine's previous key, if one is still on the server. Best
 * effort: a key we cannot see or cannot delete must not stop us minting the
 * one the user is asking for right now.
 */
async function revokePrevious(name: string): Promise<void> {
  const { apiClient } = await import('../api/client.js');
  try {
    const existing = (await apiClient('/agent/credentials')) as
      | { publicId: string; name?: string }[]
      | undefined;
    const stale = (existing ?? []).filter((c) => c?.name === name && c.publicId);
    for (const cred of stale) {
      await apiClient(`/agent/credentials/${encodeURIComponent(cred.publicId)}`, {
        method: 'DELETE',
      }).catch(() => undefined);
    }
  } catch {
    // Listing failed (offline, older backend). Minting is still worth trying.
  }
}

async function mint(): Promise<MintedCredential> {
  const { apiClient } = await import('../api/client.js');
  const name = credentialName();
  await revokePrevious(name);
  const created = (await apiClient('/agent/credentials', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })) as { accessToken?: string; publicId?: string };
  if (!created?.accessToken || !created.publicId) {
    throw new AuthError(
      'HookMyApp did not return an org credential for this machine. Run: hookmyapp doctor',
    );
  }
  return { accessToken: created.accessToken, publicId: created.publicId };
}

/**
 * The Bearer token to give an MCP client. Mints one on first use and reuses it
 * afterwards.
 *
 * A revoked key is NOT detected here — the client's next tool call 401s, and
 * `hookmyapp login` mints a fresh one. Probing the key on every header request
 * would add a round-trip to every single MCP call to catch a rare case.
 */
export async function getMcpAccessToken(): Promise<string> {
  const creds = await readCredentials();
  if (!creds) throw new AuthError('Not logged in. Run: hookmyapp login');

  // OTP login already stored an org credential — that IS the MCP token.
  if (isAgentCredential(creds)) return creds.accessToken;

  if (creds.mcpAccessToken) return creds.mcpAccessToken;

  const minted = await mint();
  await saveCredentials({
    ...creds,
    mcpAccessToken: minted.accessToken,
    mcpCredentialPublicId: minted.publicId,
  });
  return minted.accessToken;
}
