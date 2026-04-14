import { apiClient } from '../api/client.js';
import { CliError } from '../output/error.js';
import { readWorkspaceConfig, writeWorkspaceConfig } from './workspace.js';

/**
 * Resolve the caller's active workspace ID. The resolution order is:
 *   1. Whatever is persisted in ~/.hookmyapp/config.json (`activeWorkspaceId`).
 *   2. Auto-select: if the user has exactly one workspace on the backend,
 *      use it AND persist the choice so future calls skip the fetch. This
 *      gives new users a zero-friction first run — the vast majority have
 *      a single auto-provisioned workspace and should never be asked to run
 *      `workspace use <id>`.
 *   3. Ambiguous (2+ workspaces, none active) → user-facing error telling
 *      them to pick one explicitly via `hookmyapp workspace use <name|id>`.
 *   4. None at all → "you aren't a member of any workspace" error.
 */
export async function getDefaultWorkspaceId(): Promise<string> {
  const config = readWorkspaceConfig();
  if (config.activeWorkspaceId) {
    return config.activeWorkspaceId;
  }

  // No active workspace in config — resolve it.
  const workspaces = (await apiClient('/workspaces').catch(() => [])) as Array<{
    id: string;
    name: string;
  }>;

  if (Array.isArray(workspaces) && workspaces.length === 1) {
    const only = workspaces[0];
    writeWorkspaceConfig({
      activeWorkspaceId: only.id,
      activeWorkspaceSlug: only.name,
    });
    return only.id;
  }

  if (Array.isArray(workspaces) && workspaces.length > 1) {
    throw new CliError(
      `You're a member of ${workspaces.length} workspaces. Pick one first:\n  hookmyapp workspace use <name|id>`,
      'WORKSPACE_AMBIGUOUS',
    );
  }

  throw new CliError(
    'You are not a member of any workspace. Contact your workspace admin for an invite.',
    'NO_WORKSPACE',
  );
}
