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
      // Cursor is the only client holding the token literally, so it is the
      // only one still able to authenticate after the CLI's credentials are
      // gone — and the revocation above is best-effort, so offline logouts
      // leave that token live. Strip it; its entry and URL stay, so the next
      // login fills it back in.
      const { clearCursorCredential } = await import('../commands/agent.js');
      const cursorCleanup = clearCursorCredential();

      // A Cursor config we could not rewrite still holds a usable token, and
      // the revoke above is best-effort — so this is a real warning, not a
      // tidiness note.
      // Both, not one: the Claude failure is the less security-sensitive of
      // the two, and letting it win the slot would hide the fact that Cursor
      // still holds a usable bearer token.
      const warnings = [
        mcpCleanup.ok ? undefined : mcpCleanup.detail,
        cursorCleanup === 'failed'
          ? `Could not remove the HookMyApp token from Cursor's config. Delete the "headers" entry under mcpServers.hookmyapp by hand.`
          : undefined,
      ].filter((w): w is string => Boolean(w));

      if (json) {
        process.stdout.write(
          JSON.stringify({
            status: warnings.length > 0 ? 'logged_out_with_warning' : 'logged_out',
            revoked,
            mcpCleanup,
            cursorCleanup,
          }) + '\n',
        );
      } else {
        console.log(
          warnings.length > 0
            ? `\n✓ Logged out\n${warnings.map((w) => `⚠ ${w}`).join('\n')}\n`
            : '\n✓ Logged out\n',
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
