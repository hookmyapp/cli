import { apiClient } from '../api/client.js';
import { CliError } from '../output/error.js';
import { readWorkspaceConfig } from './workspace.js';

export async function getDefaultWorkspaceId(): Promise<string> {
  // Prefer workspace from config
  const config = readWorkspaceConfig();
  if (config.activeWorkspaceId) {
    return config.activeWorkspaceId;
  }

  // Fallback to first account's workspace
  const accounts = await apiClient('/meta/accounts');
  if (Array.isArray(accounts) && accounts.length > 0) {
    return accounts[0].workspaceId;
  }
  throw new CliError('No active workspace. Run: hookmyapp workspace use <id>', 'NO_WORKSPACE');
}
