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
      //   AIT-460: a WorkOS session also mints one for its MCP clients.
      let revoked = false;
      const creds = await readCredentials();
      if (creds && isAgentCredential(creds) && creds.credentialPublicId) {
        try {
          const { apiClient } = await import('../api/client.js');
          await apiClient(`/agent/credentials/${encodeURIComponent(creds.credentialPublicId)}`, {
            method: 'DELETE',
          });
          revoked = true;
        } catch {
          // Offline / already revoked — proceed to clear local credentials.
        }
      }

      // The MCP key is revoked by NAME, not by the stored id: two first-use
      // mints racing each other leave a key this machine owns but the file
      // never recorded, and revoking only what we remember would leave it live.
      // WorkOS sessions only — an agent credential may not revoke its peers.
      const { deleteMcpCredential, revokeKeysForThisMachine } = await import('./mcp-credential.js');
      if (creds && !isAgentCredential(creds)) {
        revoked = (await revokeKeysForThisMachine()) > 0 || revoked;
      }
      deleteMcpCredential();

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
