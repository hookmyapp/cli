import { Command } from 'commander';
import { deleteCredentials } from './store.js';
import { API_KEY_ENV_VAR } from '../config/env-vars.js';
import { isAgentCredential, readSecrets } from '../storage/secrets.js';
import { addExamples } from '../output/help.js';
import { removeClaudeMcp } from '../commands/mcp.js';

export function logoutCommand(program: Command): void {
  const logout = program
    .command('logout')
    .description('Remove stored credentials')
    .action(async () => {
      const json = !!program.opts().json;

      // AIT-153: for an agent credential (org API key), also revoke it
      // server-side so it can't keep being used after logout. Best-effort — an
      // offline host (or an already-revoked key) must still clear local
      // credentials. WorkOS sessions carry no CLI-side revoke, so this only
      // fires for agent credentials.
      let revoked = false;
      // Stored credential only (AIT-438): logout manages credentials.json and
      // must never revoke a key that came from HOOKMYAPP_API_KEY — the
      // environment is not ours to clear, and revoking it server-side would
      // break every other process sharing that key.
      const creds = await readSecrets();
      if (creds && isAgentCredential(creds) && creds.credentialPublicId) {
        try {
          const { apiClient } = await import('../api/client.js');
          await apiClient(`/agent/credentials/${creds.credentialPublicId}`, {
            method: 'DELETE',
          });
          revoked = true;
        } catch {
          // Offline / already revoked — proceed to clear local credentials.
        }
      }

      await deleteCredentials();
      const mcpCleanup = removeClaudeMcp();

      if (json) {
        process.stdout.write(
          JSON.stringify({
            status: mcpCleanup.ok ? 'logged_out' : 'logged_out_with_warning',
            revoked,
            mcpCleanup,
          }) + '\n',
        );
      } else {
        console.log(
          mcpCleanup.ok
            ? '\n✓ Logged out\n'
            : `\n✓ Logged out\n⚠ ${mcpCleanup.detail}\n`,
        );
        if (process.env[API_KEY_ENV_VAR]?.trim()) {
          console.log(
            `⚠ ${API_KEY_ENV_VAR} is still set — commands stay authenticated with it. Unset it to sign out fully.\n`,
          );
        }
      }
    });

  addExamples(
    logout,
    `
EXAMPLES:
  $ hookmyapp logout
  $ hookmyapp logout --json
`,
  );
}
