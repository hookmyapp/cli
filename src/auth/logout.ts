import { Command } from 'commander';
import { deleteCredentials } from './store.js';
import { API_KEY_ENV_VAR, envApiKey } from '../config/env-vars.js';
import { isAgentCredential, readSecrets } from '../storage/secrets.js';
import { addExamples } from '../output/help.js';
import { removeClaudeMcp } from '../commands/mcp.js';

export function logoutCommand(program: Command): void {
  const logout = program
    .command('logout')
    .description('Remove stored credentials')
    .action(async () => {
      const json = !!program.opts().json;
      // AIT-438: an env key keeps authenticating after logout. Humans get the
      // warning below; --json callers need the same signal in the payload, or
      // automation reads status "logged_out" and assumes it is signed out.
      const envKeyActive = Boolean(envApiKey());

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
      // The revoke goes through apiClient, which prefers the env key. Pin it
      // to the stored token so logout revokes the credential it is actually
      // clearing. The one case to skip: the env holds that SAME key — revoking
      // it would break every other process sharing it, and the user did not
      // ask to invalidate their environment (AIT-438).
      const envIsSameKey = envKeyActive && creds?.accessToken === envApiKey();
      if (creds && isAgentCredential(creds) && creds.credentialPublicId && !envIsSameKey) {
        try {
          const { apiClient } = await import('../api/client.js');
          await apiClient(`/agent/credentials/${creds.credentialPublicId}`, {
            method: 'DELETE',
            bearerToken: creds.accessToken,
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
            status:
              !mcpCleanup.ok || envKeyActive
                ? 'logged_out_with_warning'
                : 'logged_out',
            revoked,
            envKeyActive,
            ...(envKeyActive ? { envKeyVar: API_KEY_ENV_VAR, envKeyIsStoredKey: envIsSameKey } : {}),
            mcpCleanup,
          }) + '\n',
        );
      } else {
        console.log(
          mcpCleanup.ok
            ? '\n✓ Logged out\n'
            : `\n✓ Logged out\n⚠ ${mcpCleanup.detail}\n`,
        );
        if (envKeyActive) {
          console.log(
            envIsSameKey
              ? `⚠ ${API_KEY_ENV_VAR} holds this same key, so it was not revoked and commands stay authenticated with it. Unset it to sign out fully.\n`
              : `⚠ ${API_KEY_ENV_VAR} is still set — commands stay authenticated with it. Unset it to sign out fully.\n`,
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
