import { apiClient } from '../api/client.js';
import { AuthError, NetworkError, ValidationError } from '../output/error.js';
import { readWorkspaceConfig, writeWorkspaceConfig } from './workspace.js';
import { isLikelyUuid, isValidPublicId } from '../lib/publicId.js';

/**
 * Fetch /workspaces while propagating auth + network errors (so callers bubble
 * up AUTH_REQUIRED/NETWORK_ERROR with the right exit codes) and swallowing
 * only the benign "I don't care, return empty" cases.
 *
 * We cannot blanket `.catch(() => [])` because that would downgrade a 401 to
 * the "not a member of any workspace" ValidationError — hiding the real
 * authentication failure from CI scripts that check exit codes.
 */
async function listWorkspacesOrEmpty(): Promise<
  Array<{ id: string; name: string; workosOrganizationId?: string }>
> {
  try {
    return (await apiClient('/workspaces')) as Array<{
      id: string;
      name: string;
      workosOrganizationId?: string;
    }>;
  } catch (err) {
    if (err instanceof AuthError || err instanceof NetworkError) {
      throw err;
    }
    return [];
  }
}

/**
 * Resolve the caller's active workspace ID. The resolution order is:
 *   1. `--workspace <slug>` flag on the root program (highest precedence —
 *      per-invocation override for CI/scripts that juggle multiple tenants).
 *   2. Whatever is persisted in ~/.hookmyapp/config.json (`activeWorkspaceId`).
 *   3. Auto-select: if the user has exactly one workspace on the backend,
 *      use it AND persist the choice so future calls skip the fetch. This
 *      gives new users a zero-friction first run — the vast majority have
 *      a single auto-provisioned workspace and should never be asked to run
 *      `workspace use <id>`.
 *   4. Ambiguous (2+ workspaces, none active) → user-facing error telling
 *      them to pick one explicitly via `hookmyapp workspace use <name|id>`.
 *   5. None at all → "you aren't a member of any workspace" error.
 */
export async function getDefaultWorkspaceId(): Promise<string> {
  // Lazy-import program to avoid a module-level cycle with src/index.ts.
  const { program } = await import('../index.js');
  const flag = program.opts().workspace as string | undefined;
  if (flag) {
    // Phase 117: raw UUID shape is never a valid --workspace value. Short-
    // circuit with a typed ValidationError before the /workspaces round-trip
    // so scripts see exit 2 with a clear remediation hint.
    if (isLikelyUuid(flag)) {
      throw new ValidationError(
        `--workspace "${flag}" is a raw UUID — Phase 117 CLI requires a publicId (ws_<8-char>) or workspace name. Re-run: hookmyapp workspace list`,
      );
    }
    const workspaces = await listWorkspacesOrEmpty();
    const match = workspaces.find(
      (w) =>
        w.name === flag ||
        w.name.toLowerCase() === flag.toLowerCase() ||
        w.workosOrganizationId === flag ||
        w.id === flag,
    );
    if (!match) {
      // If the flag looks like a publicId but no match was found, surface
      // the shape mismatch explicitly — helps users who got the shape right
      // but picked the wrong workspace.
      const available = workspaces.map((w) => w.name).join(', ') || '(none)';
      if (isValidPublicId(flag, 'ws')) {
        throw new ValidationError(
          `Workspace ${flag} not found. Available: ${available}`,
        );
      }
      throw new ValidationError(
        `Unknown workspace: ${flag}. Available: ${available}`,
      );
    }
    return match.id;
  }

  const config = readWorkspaceConfig();
  if (config.activeWorkspaceId) {
    return config.activeWorkspaceId;
  }

  // No active workspace in config — resolve it.
  const workspaces = await listWorkspacesOrEmpty();

  if (Array.isArray(workspaces) && workspaces.length === 1) {
    const only = workspaces[0];
    writeWorkspaceConfig({
      activeWorkspaceId: only.id,
      activeWorkspaceSlug: only.name,
    });
    return only.id;
  }

  if (Array.isArray(workspaces) && workspaces.length > 1) {
    throw new ValidationError(
      `You're a member of ${workspaces.length} workspaces. Pick one first:\n  hookmyapp workspace use <name|id>`,
    );
  }

  throw new ValidationError(
    'You are not a member of any workspace. Contact your workspace admin for an invite.',
  );
}
