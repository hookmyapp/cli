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

      // Revoke every org key this session holds, so none stays usable after
      // logout. Best-effort — an offline host (or an already-revoked key) must
      // still clear local credentials.
      //   AIT-153: an OTP session IS an org key.
      //   AIT-460: a WorkOS session mints a second one for its MCP clients;
      //   deleting the local file alone would leave that live on the server,
      //   still usable by any agent config still holding it.
      let revoked = false;
      const creds = await readCredentials();
      const toRevoke = [
        creds && isAgentCredential(creds) ? creds.credentialPublicId : undefined,
        creds?.mcpCredentialPublicId,
      ].filter((id): id is string => typeof id === 'string' && id.length > 0);
      for (const publicId of toRevoke) {
        try {
          const { apiClient } = await import('../api/client.js');
          await apiClient(`/agent/credentials/${encodeURIComponent(publicId)}`, {
            method: 'DELETE',
          });
          revoked = true;
        } catch {
          // Offline / already revoked — proceed to clear local credentials.
        }
      }

      // Then sweep by name. Only the stored id is revoked above, and two
      // first-use mints racing each other leave a second key this machine owns
      // but the file never recorded. A WorkOS session only: an agent
      // credential may not revoke keys other than itself.
      if (creds && !isAgentCredential(creds)) {
        const { revokeKeysForThisMachine } = await import('./mcp-credential.js');
        await revokeKeysForThisMachine();
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
