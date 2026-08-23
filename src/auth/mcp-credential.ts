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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface MintedCredential {
  accessToken: string;
  publicId: string;
}

/**
 * Revoke every key on the server carrying this machine's name.
 *
 * Called before a mint, so a re-login replaces its own key, and again on
 * logout, where revoking by name rather than by the one stored id is what
 * closes the concurrency gap: two `mcp-headers` processes racing on first use
 * can both list an empty set and both mint, and only one id survives in the
 * file. Sweeping by name catches the one the file forgot.
 *
 * Best effort throughout: a key we cannot see or cannot delete must not stop
 * the caller doing what it was actually asked to do.
 */
export async function revokeKeysForThisMachine(name = credentialName()): Promise<void> {
  const { apiClient } = await import('../api/client.js');
  let existing: { publicId: string; name?: string }[] | undefined;
  try {
    existing = (await apiClient('/agent/credentials')) as typeof existing;
  } catch {
    // Listing failed (offline, older backend). Nothing to sweep.
    return;
  }
  for (const cred of (existing ?? []).filter((c) => c?.name === name && c.publicId)) {
    // Per key: one key we are not allowed to delete must not strand the rest.
    try {
      await apiClient(`/agent/credentials/${encodeURIComponent(cred.publicId)}`, {
        method: 'DELETE',
      });
    } catch {
      // Already revoked, or not ours to revoke.
    }
  }
}

async function mint(): Promise<MintedCredential> {
  const { apiClient } = await import('../api/client.js');
  const name = credentialName();
  await revokeKeysForThisMachine(name);
  const created = (await apiClient('/agent/credentials', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })) as { accessToken?: unknown; publicId?: unknown };
  // Types, not truthiness: `{accessToken: {}}` would satisfy a truthy check and
  // then be stringified into a Bearer header and a publicId logout cannot use.
  if (!isNonEmptyString(created?.accessToken) || !isNonEmptyString(created.publicId)) {
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
  // Re-read: the calls inside mint() go through apiClient, which refreshes an
  // expired session and writes the new tokens. Spreading the snapshot taken
  // before the mint would put the spent refresh token back on disk.
  const current = (await readCredentials()) ?? creds;
  await saveCredentials({
    ...current,
    mcpAccessToken: minted.accessToken,
    mcpCredentialPublicId: minted.publicId,
  });
  return minted.accessToken;
}
