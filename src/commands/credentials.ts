import { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { readCredentials, deleteCredentials } from '../auth/store.js';
import { isAgentCredential } from '../storage/secrets.js';
import { addExamples } from '../output/help.js';

interface AgentCredentialRow {
  publicId: string;
  /** Null for legacy keys created before names existed. */
  name?: string | null;
  scopes?: string[];
}

/** Manage auth.md agent credentials (ac_ Bearer tokens). */
export function registerCredentialsCommand(program: Command): void {
  const credentials = program
    .command('credentials')
    .description('List and revoke agent credentials');

  const list = credentials
    .command('list')
    .description('List your agent credentials')
    .action(async () => {
      const data = await apiClient('/agent/credentials');
      if (program.opts().json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const rows: AgentCredentialRow[] = Array.isArray(data) ? data : [];
      if (rows.length === 0) {
        console.log(
          'No agent credentials. Create one with: hookmyapp login --email <you@example.com>',
        );
        return;
      }
      for (const r of rows) {
        console.log(`${r.publicId}  ${r.name ?? '(unnamed)'}  ${(r.scopes ?? []).join(', ')}`);
      }
    });

  const revoke = credentials
    .command('revoke <publicId>')
    .description('Revoke an agent credential')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (publicId: string, opts: { yes?: boolean }) => {
      const isJson = Boolean(program.opts().json);
      if (!opts.yes && !isJson) {
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({
          message: `Revoke credential ${publicId}?`,
          default: false,
        });
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }
      await apiClient(`/agent/credentials/${encodeURIComponent(publicId)}`, {
        method: 'DELETE',
      });
      // If this is the credential we're currently authenticated with, drop the
      // now-dead token from disk so the next command doesn't send a 401.
      const creds = await readCredentials();
      if (creds && isAgentCredential(creds) && creds.credentialPublicId === publicId) {
        await deleteCredentials();
      }
      if (isJson) {
        console.log(JSON.stringify({ ok: true, revoked: publicId }));
        return;
      }
      console.log(`Revoked ${publicId}`);
    });

  addExamples(
    credentials,
    `
EXAMPLES:
  $ hookmyapp credentials list
  $ hookmyapp credentials revoke ac_ab12cd34 -y
`,
  );

  addExamples(
    list,
    `
EXAMPLES:
  $ hookmyapp credentials list
  $ hookmyapp credentials list --json
`,
  );

  addExamples(
    revoke,
    `
EXAMPLES:
  $ hookmyapp credentials revoke ac_ab12cd34
  $ hookmyapp credentials revoke ac_ab12cd34 -y
`,
  );
}
