import type { Command } from 'commander';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { output } from '../output/format.js';
import { CliError } from '../output/error.js';
import type { Workspace } from '../types/workspace.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.hookmyapp');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface WorkspaceConfig {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
}

export function readWorkspaceConfig(): WorkspaceConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeWorkspaceConfig(config: WorkspaceConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export async function resolveWorkspace(nameOrId: string): Promise<{ id: string; name: string; role: string }> {
  const workspaces = await apiClient('/workspaces');
  // UUID detection: starts with 8 hex chars + hyphen + 4 hex chars
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(nameOrId)) {
    const found = workspaces.find((w: any) => w.id === nameOrId);
    if (found) return found;
  }
  // Case-insensitive name match
  const matches = workspaces.filter((w: any) => w.name.toLowerCase() === nameOrId.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new CliError(`workspace "${nameOrId}" not found`, 'NOT_FOUND');
  }
  // Ambiguous
  const lines = [`multiple workspaces named "${nameOrId}":`];
  for (const w of matches) {
    lines.push(`  ${w.id}  (role: ${w.role})`);
  }
  lines.push('', 'Use the workspace ID instead: hookmyapp workspace use <id>');
  throw new CliError(lines.join('\n'), 'AMBIGUOUS_WORKSPACE');
}

const VALID_ASSIGNABLE_ROLES = ['admin', 'member'];

function validateAssignableRole(role: string): void {
  if (!VALID_ASSIGNABLE_ROLES.includes(role)) {
    throw new CliError(`invalid role "${role}". Use: admin, member`, 'VALIDATION_ERROR');
  }
}

export async function resolveMemberByEmail(workspaceId: string, email: string): Promise<any> {
  const data = await apiClient(`/workspaces/${workspaceId}/members`);
  const member = data.members.find((m: any) => m.user.email.toLowerCase() === email.toLowerCase());
  if (!member) {
    throw new CliError(`member "${email}" not found in workspace`, 'NOT_FOUND');
  }
  return member;
}

export async function resolveInviteByIdOrEmail(workspaceId: string, idOrEmail: string): Promise<any> {
  const data = await apiClient(`/workspaces/${workspaceId}/members`);
  const uuidMatch = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
  let invite;
  if (uuidMatch.test(idOrEmail)) {
    invite = data.invites.find((i: any) => i.id === idOrEmail);
  } else {
    invite = data.invites.find((i: any) => i.email.toLowerCase() === idOrEmail.toLowerCase());
  }
  if (!invite) {
    throw new CliError(`invite "${idOrEmail}" not found in workspace`, 'NOT_FOUND');
  }
  return invite;
}

export function registerWorkspaceCommand(program: Command): void {
  const ws = program.command('workspace').description('Manage workspaces');

  ws.command('list')
    .description('List all workspaces')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const data = (await apiClient('/workspaces')) as Workspace[];
      const config = readWorkspaceConfig();
      if (opts.json || program.opts().human !== true) {
        // JSON: include raw array with workosOrganizationId when --json or non-human default
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
      }
      if (program.opts().human) {
        const rows = data.map((w) => ({
          ACTIVE: w.id === config.activeWorkspaceId ? '*' : ' ',
          NAME: w.name,
          SLUG: w.workosOrganizationId,
          ROLE: w.role,
        }));
        output(rows, { human: true });
        return;
      }
      // Default (non-human, no --json): still emit JSON array
      console.log(JSON.stringify(data, null, 2));
    });

  ws.command('new')
    .description('Create a new workspace')
    .argument('<name>', 'Workspace name')
    .action(async (name: string) => {
      const result = await apiClient('/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      writeWorkspaceConfig({
        activeWorkspaceId: result.id,
        activeWorkspaceSlug: result.name,
      });
      // Refresh JWT so it's scoped to the newly-created workspace's WorkOS org;
      // without this, subsequent commands (e.g. `workspace current`) hit the
      // backend with a token still bound to the previous org and get 403.
      if (result.workosOrganizationId) {
        await forceTokenRefresh(result.workosOrganizationId);
      }
      if (program.opts().human) {
        console.log(`Created workspace "${result.name}" and switched to it`);
      } else {
        output(result, { human: program.opts().human });
      }
    });

  ws.command('current')
    .description('Show active workspace details')
    .action(async () => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      // Fetch list (has role) and detail (has counts)
      const [workspaces, detail] = await Promise.all([
        apiClient('/workspaces'),
        apiClient(`/workspaces/${workspaceId}`),
      ]);
      const listEntry = workspaces.find((w: any) => w.id === workspaceId);
      const merged = { ...detail, role: listEntry?.role };
      if (program.opts().human) {
        console.log(`Name:          ${merged.name}`);
        console.log(`ID:            ${merged.id}`);
        console.log(`Role:          ${merged.role ?? 'unknown'}`);
        console.log(`Members:       ${merged.memberCount}`);
        console.log(`Accounts:      ${merged.accountCount}`);
      } else {
        output(merged, { human: false });
      }
    });

  ws.command('rename')
    .description('Rename the active workspace')
    .argument('<new-name>', 'New workspace name')
    .action(async (newName: string) => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const result = await apiClient(`/workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
      });
      if (program.opts().human) {
        console.log(`Renamed workspace to "${result.name}"`);
      } else {
        output(result, { human: program.opts().human });
      }
    });

  ws.command('use')
    .description('Switch the active workspace')
    .argument('[name-or-id]', 'Workspace name or ID (omit for interactive picker)')
    .action(async (nameOrId?: string) => {
      let workspace: Workspace;
      if (nameOrId) {
        workspace = (await resolveWorkspace(nameOrId)) as unknown as Workspace;
      } else {
        if (!process.stdout.isTTY) {
          const err = new CliError(
            'Workspace identifier required (non-TTY). Usage: hookmyapp workspace use <slug-or-id>',
            'USAGE_ERROR',
          );
          err.exitCode = 2;
          throw err;
        }
        const { select } = await import('@inquirer/prompts');
        const workspaces = (await apiClient('/workspaces')) as Workspace[];
        const chosenId = await select({
          message: 'Select a workspace',
          choices: workspaces.map((w) => ({
            name: `${w.name} (${w.role})`,
            value: w.id,
            description: w.workosOrganizationId,
          })),
        });
        workspace = workspaces.find((w) => w.id === chosenId)!;
      }
      writeWorkspaceConfig({
        activeWorkspaceId: workspace.id,
        activeWorkspaceSlug: workspace.name,
      });
      await forceTokenRefresh(workspace.workosOrganizationId);
      console.log(`Active workspace: ${workspace.name} (${workspace.id})`);
    });

  // --- Members subcommand group ---
  const members = ws.command('members').description('Manage workspace members');

  members.command('list')
    .description('List workspace members and pending invites')
    .action(async () => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const data = await apiClient(`/workspaces/${workspaceId}/members`);
      const rows = [
        ...data.members.map((m: any) => ({
          email: m.user.email,
          name: `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`.trim() || '-',
          role: m.role,
          status: 'active',
        })),
        ...data.invites.map((i: any) => ({
          email: i.email,
          name: '-',
          role: i.role,
          status: 'pending',
        })),
      ];
      output(rows, { human: program.opts().human });
    });

  members.command('invite')
    .description('Invite a member to the workspace')
    .argument('<email>', 'Email address to invite')
    .option('--role <role>', 'Role (admin or member)', 'member')
    .action(async (email: string, opts: { role: string }) => {
      validateAssignableRole(opts.role);
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const result = await apiClient(`/workspaces/${workspaceId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role: opts.role }),
      });
      if (program.opts().human) {
        console.log(`Invited ${email} as ${opts.role} to workspace`);
      } else {
        output(result, { human: false });
      }
    });

  members.command('remove')
    .description('Remove a member from the workspace')
    .argument('<email>', 'Member email to remove')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (email: string, opts: { yes?: boolean }) => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const member = await resolveMemberByEmail(workspaceId, email);
      if (!opts.yes) {
        console.log(`Would remove ${email} (role: ${member.role}) from workspace. Pass --yes to confirm.`);
        process.exit(0);
      }
      await apiClient(`/workspaces/${workspaceId}/members/${member.id}`, {
        method: 'DELETE',
      });
      if (program.opts().human) {
        console.log(`Removed ${email} from workspace`);
      } else {
        output({ success: true }, { human: false });
      }
    });

  members.command('role')
    .description('Update a member role')
    .argument('<email>', 'Member email')
    .requiredOption('--role <role>', 'New role (admin or member)')
    .action(async (email: string, opts: { role: string }) => {
      validateAssignableRole(opts.role);
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const member = await resolveMemberByEmail(workspaceId, email);
      const result = await apiClient(`/workspaces/${workspaceId}/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: opts.role }),
      });
      if (program.opts().human) {
        console.log(`Updated ${email} role to ${opts.role}`);
      } else {
        output(result, { human: false });
      }
    });

  // --- Invites subcommand group ---
  const invites = ws.command('invites').description('Manage workspace invites');

  invites.command('cancel')
    .description('Cancel a pending invite')
    .argument('<id-or-email>', 'Invite ID or email')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (idOrEmail: string, opts: { yes?: boolean }) => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const invite = await resolveInviteByIdOrEmail(workspaceId, idOrEmail);
      if (!opts.yes) {
        console.log(`Would cancel invite for ${invite.email}. Pass --yes to confirm.`);
        process.exit(0);
      }
      await apiClient(`/workspaces/${workspaceId}/invites/${invite.id}`, {
        method: 'DELETE',
      });
      if (program.opts().human) {
        console.log(`Cancelled invite for ${invite.email}`);
      } else {
        output({ success: true }, { human: false });
      }
    });
}
