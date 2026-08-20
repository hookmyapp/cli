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
      // The revoke call goes through apiClient, which authenticates with the
      // env key while it is set. If both hold the same key, the "self-revoke"
      // would kill the environment credential every other process is using;
      // if they differ, the backend rejects it as a non-self revoke anyway.
      // Skip it and say so — the local credential is still cleared.
      if (envKeyActive && creds && isAgentCredential(creds)) {
        console.error(
          `\n⚠ Stored key ${creds.credentialPublicId ?? ''} was not revoked server-side: ` +
            `while ${API_KEY_ENV_VAR} is set, the request would authenticate as that key. ` +
            `Unset it and run: hookmyapp credentials revoke ${creds.credentialPublicId ?? '<id>'}\n`,
        );
      } else if (creds && isAgentCredential(creds) && creds.credentialPublicId) {
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
            status:
              !mcpCleanup.ok || envKeyActive
                ? 'logged_out_with_warning'
                : 'logged_out',
            revoked,
            envKeyActive,
            ...(envKeyActive ? { envKeyVar: API_KEY_ENV_VAR } : {}),
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
