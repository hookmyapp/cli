import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { readCredentials } from './store.js';
import { isAgentCredential } from '../storage/secrets.js';
import { getMcpCredentialFile, safeWriteFileSync } from '../storage/path.js';
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
 *
 * It lives in its OWN file rather than as fields on credentials.json. Sharing
 * that file meant every mint rewrote the whole session record, so a logout
 * landing mid-mint was undone by the write that followed it and the CLI stayed
 * logged in after logout reported success. Nothing here writes the session, so
 * that cannot happen.
 *
 * A mint racing a logout is still possible the other way: logout sweeps this
 * machine's keys, then our POST creates a new one the sweep never saw. That key
 * would be live, not merely stale, so the session is re-checked after the mint
 * and a key that outlived its session is revoked rather than kept.
 */

/** `POST /agent/credentials` caps the name at 60 characters. */
const NAME_MAX = 60;

/** Stable per-machine name, so a re-login replaces its own key instead of
 *  stacking a new one on the user's API-keys page every time. */
export function credentialName(host = hostname()): string {
  return `${host} (HookMyApp CLI)`.slice(0, NAME_MAX);
}

export interface StoredMcpCredential {
  accessToken: string;
  publicId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function readMcpCredential(): StoredMcpCredential | null {
  const path = getMcpCredentialFile();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredMcpCredential>;
    if (!isNonEmptyString(parsed?.accessToken) || !isNonEmptyString(parsed.publicId)) return null;
    return { accessToken: parsed.accessToken, publicId: parsed.publicId };
  } catch {
    return null;
  }
}

/** Forget the local copy. Does not revoke — callers needing that say so. */
export function deleteMcpCredential(): void {
  const path = getMcpCredentialFile();
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/**
 * Revoke every key on the server carrying this machine's name.
 *
 * Called before a mint, so a re-login replaces its own key, and again on
 * logout, where revoking by name rather than by the one stored id is what
 * closes the concurrency gap: two `mcp-headers` processes racing on first use
 * can both find no key and both mint, and only one ends up in the file.
 * Sweeping by name catches the one the file forgot.
 *
 * Best effort throughout: a key we cannot see or cannot delete must not stop
 * the caller doing what it was actually asked to do.
 *
 * Returns how many keys were actually revoked, so logout can report what it
 * really did instead of claiming a revocation that never happened.
 */
export async function revokeKeysForThisMachine(name = credentialName()): Promise<number> {
  const { apiClient } = await import('../api/client.js');
  let existing: { publicId: string; name?: string }[] | undefined;
  try {
    existing = (await apiClient('/agent/credentials')) as typeof existing;
  } catch {
    // Listing failed (offline, older backend). Nothing to sweep.
    return 0;
  }
  // Array.isArray, not `?? []`: apiClient is untyped, and a successful
  // non-array body (an error envelope, a paginated wrapper) would throw out of
  // here on .filter. This runs inside logout BEFORE the local credentials are
  // deleted, so that throw would leave the user logged in.
  const rows = Array.isArray(existing) ? existing : [];
  let revoked = 0;
  for (const cred of rows.filter((c) => c?.name === name && c.publicId)) {
    // Per key: one key we are not allowed to delete must not strand the rest.
    try {
      await apiClient(`/agent/credentials/${encodeURIComponent(cred.publicId)}`, {
        method: 'DELETE',
      });
      revoked += 1;
    } catch {
      // Already revoked, or not ours to revoke.
    }
  }
  return revoked;
}

/**
 * Revoke and forget the credential belonging to a session that is about to be
 * replaced.
 *
 * Must run BEFORE the new session is written. The DELETE authenticates as the
 * session that minted the key, so once the new credentials are on disk the old
 * account's key is unreachable and stays live indefinitely — and a running
 * Cursor holds its loaded token until it restarts, so that is not theoretical.
 *
 * Best effort on the network call: offline, or a key already revoked from the
 * dashboard, must not block a login. The local copy goes either way — it does
 * not belong to the session being written.
 */
export async function revokePreviousMcpCredential(): Promise<void> {
  const stored = readMcpCredential();
  if (!stored) return;
  try {
    const { apiClient } = await import('../api/client.js');
    await apiClient(`/agent/credentials/${encodeURIComponent(stored.publicId)}`, {
      method: 'DELETE',
    });
  } catch {
    // Offline, expired session, or already revoked.
  }
  deleteMcpCredential();
}

async function mint(): Promise<StoredMcpCredential> {
  const { apiClient } = await import('../api/client.js');
  const name = credentialName();
  await revokeKeysForThisMachine(name);
  // `token`, NOT `accessToken`. The two credential endpoints disagree:
  // /agent/auth/claim/complete (the OTP flow) answers with `accessToken`, and
  // this one answers `{ token, publicId, scopes, name }`. Reading the wrong
  // field failed the guard below and killed the feature outright — and no unit
  // test caught it, because they mocked the shape this file assumed rather
  // than the shape the server sends.
  const created = (await apiClient('/agent/credentials', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })) as { token?: unknown; publicId?: unknown };
  // Types, not truthiness: `{token: {}}` would satisfy a truthy check and then
  // be stringified into a Bearer header, alongside a publicId logout could
  // never revoke.
  if (!isNonEmptyString(created?.token) || !isNonEmptyString(created.publicId)) {
    throw new AuthError(
      'HookMyApp did not return an org credential for this machine. Run: hookmyapp doctor',
    );
  }
  return { accessToken: created.token, publicId: created.publicId };
}

/** Best-effort undo for a key we minted but are not going to keep. */
async function revokeMinted(publicId: string): Promise<void> {
  try {
    const { apiClient } = await import('../api/client.js');
    await apiClient(`/agent/credentials/${encodeURIComponent(publicId)}`, { method: 'DELETE' });
  } catch {
    // The credentials it would authenticate with may be the ones just deleted.
  }
}

/**
 * The Bearer token to give an MCP client. Mints one on first use and reuses it
 * afterwards.
 *
 * A key revoked from the dashboard is NOT noticed here — the client's next tool
 * call 401s and `hookmyapp login` mints a fresh one. Probing on every header
 * request would add a round-trip to every MCP call to catch a rare case.
 * Revoking through `hookmyapp credentials revoke` DOES clear it, because that
 * path knows which key it just killed.
 */
export async function getMcpAccessToken(): Promise<string> {
  const creds = await readCredentials();
  if (!creds) throw new AuthError('Not logged in. Run: hookmyapp login');

  // OTP login already stored an org credential — that IS the MCP token.
  if (isAgentCredential(creds)) return creds.accessToken;

  const stored = readMcpCredential();
  if (stored) return stored.accessToken;

  const minted = await mint();
  // Re-check: a logout during the mint has already swept this machine's keys,
  // and the one we just created came after that sweep — live, and about to be
  // written to a machine that is supposed to be logged out.
  if (!(await readCredentials())) {
    await revokeMinted(minted.publicId);
    throw new AuthError('Logged out while setting up MCP access. Run: hookmyapp login');
  }
  const path = getMcpCredentialFile();
  safeWriteFileSync(path, JSON.stringify(minted, null, 2));
  chmodSync(path, 0o600);
  return minted.accessToken;
}
