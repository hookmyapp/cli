import { Command } from 'commander';
import { readCredentials, deleteCredentials } from './store.js';
import { isAgentCredential } from '../storage/secrets.js';
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
      const creds = await readCredentials();
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
