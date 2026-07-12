import { Command } from 'commander';
import { readCredentials, deleteCredentials } from './store.js';
import { isAgentCredential } from '../storage/secrets.js';
import { addExamples } from '../output/help.js';

export function logoutCommand(program: Command): void {
  const logout = program
    .command('logout')
    .description('Remove stored credentials')
    .action(async () => {
      const json = !!program.opts().json;

      // AIT-153: for an agent credential (an `ac_`/API key), also revoke it
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

      if (json) {
        process.stdout.write(
          JSON.stringify({ status: 'logged_out', revoked }) + '\n',
        );
      } else {
        console.log('\n✓ Logged out\n');
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
