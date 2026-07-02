import type { Command } from 'commander';
import { apiClient, forceTokenRefresh } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import type { Workspace } from '../types/workspace.js';
import { isLikelyUuid, isValidPublicId } from '../lib/publicId.js';
import fs from 'node:fs';
import { getConfigFile, safeWriteFileSync } from '../storage/path.js';

export interface WorkspaceConfig {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
}

/**
 * The on-disk shape of `~/.hookmyapp/config.json`. This is shared with
 * `src/config/env-profiles.ts`, which owns the `env` field. Both modules
 * MUST merge-read-then-write (see writeWorkspaceConfig / setPersistedEnv)
 * rather than overwrite, or they'll clobber each other's fields.
 */
interface FullPersistedConfig {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
  env?: string;
}

function readFullConfig(): FullPersistedConfig {
  try {
    return JSON.parse(fs.readFileSync(getConfigFile(), 'utf-8'));
  } catch {
    return {};
  }
}

export function readWorkspaceConfig(): WorkspaceConfig {
  const full = readFullConfig();
  // Phase 117 hard cutover: activeWorkspaceId on disk MUST be a ws_ publicId.
  // A stale UUID from a pre-0.5.0 install is silently dropped so the next
  // caller falls through to the single-workspace auto-pick or the login
  // wizard's picker. No UUID value ever leaks back out to the backend.
  const activeWorkspaceId =
    full.activeWorkspaceId && isValidPublicId(full.activeWorkspaceId, 'ws')
      ? full.activeWorkspaceId
      : undefined;
  return {
    activeWorkspaceId,
    activeWorkspaceSlug: activeWorkspaceId ? full.activeWorkspaceSlug : undefined,
  };
}

export function writeWorkspaceConfig(config: WorkspaceConfig): void {
  // Phase 117 hard cutover: refuse to persist a UUID-shaped activeWorkspaceId.
  // Symmetric with the read-side drop in readWorkspaceConfig — invariant is
  // "no UUID ever reaches disk or escapes to the backend."
  if (config.activeWorkspaceId && !isValidPublicId(config.activeWorkspaceId, 'ws')) {
    throw new ValidationError(
      `activeWorkspaceId "${config.activeWorkspaceId}" is not a valid ws_ publicId. This is a bug: callers must pass the server-returned publicId.`,
    );
  }
  // Merge with existing config so we never clobber env-profiles fields
  // (specifically `env`). See env-profiles.ts for the other half.
  const existing = readFullConfig();
  const merged: FullPersistedConfig = {
    ...existing,
    activeWorkspaceId: config.activeWorkspaceId,
    activeWorkspaceSlug: config.activeWorkspaceSlug,
  };
  safeWriteFileSync(getConfigFile(), JSON.stringify(merged, null, 2) + '\n');
}

export async function resolveWorkspace(nameOrId: string, kind?: 'team' | 'customer'): Promise<{ id: string; name: string; role: string; workosOrganizationId: string }> {
  // Phase 117: raw UUID input is not an accepted shape. A `ws_` publicId,
  // a workspace name, or a WorkOS organizationId (slug) are the three
  // accepted identifier shapes — matching what the backend now surfaces
  // over HTTP. If the caller passes a UUID, short-circuit with a typed
  // error instead of silently accepting it (would 400 at the backend).
  if (isLikelyUuid(nameOrId)) {
    throw new ValidationError(
      `workspace identifier "${nameOrId}" is a raw UUID. Phase 117 CLI requires a publicId (ws_<8-char>) or workspace name. Re-run: hookmyapp workspace list`,
    );
  }

  // When `kind` is set the candidate set is restricted to that kind, so
  // `customers use` can never silently switch into a team workspace.
  const noun = kind === 'customer' ? 'customer' : 'workspace';
  const all = await apiClient('/workspaces');
  const workspaces = kind ? all.filter((w: any) => w.kind === kind) : all;
  // publicId detection: ws_ prefixed, 8-char alphanumeric body.
  if (isValidPublicId(nameOrId, 'ws')) {
    const found = workspaces.find((w: any) => w.id === nameOrId);
    if (found) return found;
    throw new ValidationError(`${noun} "${nameOrId}" not found`);
  }
  // WorkOS organization id shape (slug) — exact match, case-sensitive.
  const orgMatch = workspaces.find((w: any) => w.workosOrganizationId === nameOrId);
  if (orgMatch) return orgMatch;
  // Case-insensitive name match
  const matches = workspaces.filter((w: any) => w.name.toLowerCase() === nameOrId.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new ValidationError(`${noun} "${nameOrId}" not found`);
  }
  // Ambiguous
  const lines = [`multiple ${noun}s named "${nameOrId}":`];
  for (const w of matches) {
    lines.push(`  ${w.id}  (role: ${w.role})`);
  }
  lines.push('', `Use the ${noun} publicId instead: hookmyapp ${kind === 'customer' ? 'customers' : 'workspace'} use <ws_xxxxxxxx>`);
  throw new ValidationError(lines.join('\n'));
}

/**
 * Resolve (or interactively pick) a workspace, re-scope the token to its
 * WorkOS org, and persist it as the active workspace. Shared by
 * `workspace use` and `customers use`; `opts.kind` restricts the candidate
 * set (both resolve and picker) to that kind.
 */
export async function switchActiveWorkspace(
  nameOrId: string | undefined,
  opts: { kind?: 'team' | 'customer' } = {},
): Promise<Workspace> {
  const noun = opts.kind === 'customer' ? 'customer' : 'workspace';
  let workspace: Workspace;
  if (nameOrId) {
    workspace = (await resolveWorkspace(nameOrId, opts.kind)) as unknown as Workspace;
  } else {
    if (!process.stdout.isTTY) {
      throw new ValidationError(
        `${noun[0].toUpperCase()}${noun.slice(1)} identifier required (non-TTY). Usage: hookmyapp ${opts.kind === 'customer' ? 'customers' : 'workspace'} use <name-or-ws_publicId>`,
      );
    }
    const { select } = await import('@inquirer/prompts');
    const all = (await apiClient('/workspaces')) as Workspace[];
    const workspaces = opts.kind ? all.filter((w) => w.kind === opts.kind) : all;
    const chosenId = await select({
      message: `Select a ${noun}`,
      choices: workspaces.map((w) => ({
        name: `${w.name} (${w.role})`,
        value: w.id,
        description: w.workosOrganizationId,
      })),
    });
    workspace = workspaces.find((w) => w.id === chosenId)!;
  }
  // Re-scope the token to the target org BEFORE persisting the switch, so
  // a failed refresh never leaves config pointing at a workspace the token
  // isn't valid for (previously config was written first → poisoned state).
  await forceTokenRefresh(workspace.workosOrganizationId);
  writeWorkspaceConfig({
    activeWorkspaceId: workspace.id,
    activeWorkspaceSlug: workspace.name,
  });
  return workspace;
}

const VALID_ASSIGNABLE_ROLES = ['admin', 'member'];

function validateAssignableRole(role: string): void {
  if (!VALID_ASSIGNABLE_ROLES.includes(role)) {
    throw new ValidationError(`invalid role "${role}". Use: admin, member`);
  }
}

export async function resolveMemberByEmail(workspaceId: string, email: string): Promise<any> {
  const data = await apiClient(`/workspaces/${workspaceId}/members`);
  const member = data.members.find((m: any) => m.email.toLowerCase() === email.toLowerCase());
  if (!member) {
    throw new ValidationError(`member "${email}" not found in workspace`);
  }
  return member;
}

export async function resolveInviteByIdOrEmail(workspaceId: string, idOrEmail: string): Promise<any> {
  const data = await apiClient(`/workspaces/${workspaceId}/members`);
  let invite;
  if (isValidPublicId(idOrEmail, 'inv')) {
    invite = data.invites.find((i: any) => i.id === idOrEmail);
  } else {
    invite = data.invites.find((i: any) => i.email.toLowerCase() === idOrEmail.toLowerCase());
  }
  if (!invite) {
    throw new ValidationError(`invite "${idOrEmail}" not found in workspace`);
  }
  return invite;
}

export function registerWorkspaceCommand(program: Command): void {
  const ws = program.command('workspace').description('Manage workspaces');

  const wsList = ws.command('list')
    .description('List your team workspaces')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      // The workspace surface is team-only BY DESIGN — customers are a
      // separate surface (`hookmyapp customers`), mirroring the app's
      // Workspaces vs SaaS -> Customers split. Strict equality also enforces
      // the fail-safe: an unknown kind never renders as a team workspace.
      const all = (await apiClient('/workspaces')) as Workspace[];
      const data = all.filter((w) => w.kind === 'team');
      const config = readWorkspaceConfig();
      if (opts.json || !program.opts().json !== true) {
        // JSON: include raw array with workosOrganizationId when --json or non-human default
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
      }
      if (!program.opts().json) {
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

  const wsNew = ws.command('new')
    .description('Create a new workspace')
    .argument('<name>', 'Workspace name')
    .action(async (name: string) => {
      const result = await apiClient('/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      // Persist the ws_ publicId, never the raw DB UUID (`result.id`). The
      // create endpoint returns the raw row whose `id` is the UUID;
      // writeWorkspaceConfig rejects a non-publicId, which previously broke
      // `workspace new` with exit 2.
      writeWorkspaceConfig({
        activeWorkspaceId: result.publicId,
        activeWorkspaceSlug: result.name,
      });
      // Refresh JWT so it's scoped to the newly-created workspace's WorkOS org;
      // without this, subsequent commands (e.g. `workspace current`) hit the
      // backend with a token still bound to the previous org and get 403.
      if (result.workosOrganizationId) {
        await forceTokenRefresh(result.workosOrganizationId);
      }
      if (!program.opts().json) {
        console.log(`Created workspace "${result.name}" and switched to it`);
      } else {
        output({ id: result.publicId, name: result.name }, { human: false });
      }
    });

  const wsCurrent = ws.command('current')
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
      if (!program.opts().json) {
        console.log(`Name:          ${merged.name}`);
        console.log(`ID:            ${merged.id}`);
        console.log(`Role:          ${merged.role ?? 'unknown'}`);
        console.log(`Members:       ${merged.memberCount}`);
        console.log(`Channels:      ${merged.channelCount}`);
      } else {
        output(merged, { human: false });
      }
    });

  const wsRename = ws.command('rename')
    .description('Rename the active workspace')
    .argument('<new-name>', 'New workspace name')
    .action(async (newName: string) => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const result = await apiClient(`/workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
      });
      if (!program.opts().json) {
        console.log(`Renamed workspace to "${result.name}"`);
      } else {
        // Emit a clean public DTO; the PATCH endpoint returns the raw row
        // (raw UUID `id` + workosOrganizationId) which must never reach stdout.
        output({ id: result.publicId, name: result.name }, { human: false });
      }
    });

  const wsUse = ws.command('use')
    .description('Switch the active workspace')
    .argument('[name-or-id]', 'Workspace name or publicId (ws_XXXXXXXX). Omit for interactive picker.')
    .action(async (nameOrId?: string) => {
      // Team-only, matching `workspace list`; switching into a customer goes
      // through `hookmyapp customers use`.
      const workspace = await switchActiveWorkspace(nameOrId, { kind: 'team' });
      if (program.opts().json) {
        output({ id: workspace.id, name: workspace.name }, { human: false });
      } else {
        console.log(`Active workspace: ${workspace.name} (${workspace.id})`);
      }
    });

  // --- Members subcommand group ---
  const members = ws.command('members').description('Manage workspace members');

  const membersList = members.command('list')
    .description('List workspace members and pending invites')
    .action(async () => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const data = await apiClient(`/workspaces/${workspaceId}/members`);
      const rows = [
        ...data.members.map((m: any) => ({
          email: m.email,
          name: `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim() || '-',
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
      output(rows, { human: !program.opts().json });
    });

  const membersInvite = members.command('invite')
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
      if (!program.opts().json) {
        console.log(`Invited ${email} as ${opts.role} to workspace`);
      } else {
        output(result, { human: false });
      }
    });

  const membersRemove = members.command('remove')
    .description('Remove a member from the workspace')
    .argument('<email>', 'Member email to remove')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (email: string, opts: { yes?: boolean }) => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const member = await resolveMemberByEmail(workspaceId, email);
      if (!opts.yes) {
        // Dry-run. Return (don't process.exit) so the normal flushAndExit(0)
        // path runs the telemetry flush, and emit JSON under --json so machine
        // consumers don't get human text on stdout.
        if (program.opts().json) {
          output(
            { dryRun: true, action: 'remove-member', email, role: member.role },
            { human: false },
          );
        } else {
          console.log(`Would remove ${email} (role: ${member.role}) from workspace. Pass --yes to confirm.`);
        }
        return;
      }
      await apiClient(`/workspaces/${workspaceId}/members/${member.id}`, {
        method: 'DELETE',
      });
      if (!program.opts().json) {
        console.log(`Removed ${email} from workspace`);
      } else {
        output({ success: true }, { human: false });
      }
    });

  const membersRole = members.command('role')
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
      if (!program.opts().json) {
        console.log(`Updated ${email} role to ${opts.role}`);
      } else {
        output(result, { human: false });
      }
    });

  // --- Invites subcommand group ---
  const invites = ws.command('invites').description('Manage workspace invites');

  const invitesCancel = invites.command('cancel')
    .description('Cancel a pending invite')
    .argument('<id-or-email>', 'Invite ID or email')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (idOrEmail: string, opts: { yes?: boolean }) => {
      const { getDefaultWorkspaceId } = await import('./_helpers.js');
      const workspaceId = await getDefaultWorkspaceId();
      const invite = await resolveInviteByIdOrEmail(workspaceId, idOrEmail);
      if (!opts.yes) {
        // Dry-run. Return (don't process.exit) so flushAndExit(0) runs, and
        // emit JSON under --json instead of human text on stdout.
        if (program.opts().json) {
          output(
            { dryRun: true, action: 'cancel-invite', email: invite.email },
            { human: false },
          );
        } else {
          console.log(`Would cancel invite for ${invite.email}. Pass --yes to confirm.`);
        }
        return;
      }
      await apiClient(`/workspaces/${workspaceId}/invites/${invite.id}`, {
        method: 'DELETE',
      });
      if (!program.opts().json) {
        console.log(`Cancelled invite for ${invite.email}`);
      } else {
        output({ success: true }, { human: false });
      }
    });

  addExamples(
    ws,
    `
EXAMPLES:
  $ hookmyapp workspace list
  $ hookmyapp workspace use acme-corp
  $ hookmyapp workspace current
`,
  );

  addExamples(
    wsList,
    `
EXAMPLES:
  $ hookmyapp workspace list
  $ hookmyapp workspace list --json
`,
  );

  addExamples(
    wsNew,
    `
EXAMPLES:
  $ hookmyapp workspace new "Acme Corp"
  $ hookmyapp workspace new "Personal"
`,
  );

  addExamples(
    wsCurrent,
    `
EXAMPLES:
  $ hookmyapp workspace current
  $ hookmyapp workspace current --json
`,
  );

  addExamples(
    wsRename,
    `
EXAMPLES:
  $ hookmyapp workspace rename "New Name"
  $ hookmyapp workspace rename "Acme Inc."
`,
  );

  addExamples(
    wsUse,
    `
EXAMPLES:
  $ hookmyapp workspace use acme-corp
  $ hookmyapp workspace use
`,
  );

  addExamples(
    members,
    `
EXAMPLES:
  $ hookmyapp workspace members list
  $ hookmyapp workspace members invite teammate@acme.com --role admin
  $ hookmyapp workspace members remove teammate@acme.com --yes
`,
  );

  addExamples(
    membersList,
    `
EXAMPLES:
  $ hookmyapp workspace members list
  $ hookmyapp workspace members list --json
`,
  );

  addExamples(
    membersInvite,
    `
EXAMPLES:
  $ hookmyapp workspace members invite teammate@acme.com
  $ hookmyapp workspace members invite teammate@acme.com --role admin
`,
  );

  addExamples(
    membersRemove,
    `
EXAMPLES:
  $ hookmyapp workspace members remove teammate@acme.com
  $ hookmyapp workspace members remove teammate@acme.com --yes
`,
  );

  addExamples(
    membersRole,
    `
EXAMPLES:
  $ hookmyapp workspace members role teammate@acme.com --role admin
  $ hookmyapp workspace members role teammate@acme.com --role member
`,
  );

  addExamples(
    invites,
    `
EXAMPLES:
  $ hookmyapp workspace invites cancel teammate@acme.com
  $ hookmyapp workspace invites cancel teammate@acme.com --yes
`,
  );

  addExamples(
    invitesCancel,
    `
EXAMPLES:
  $ hookmyapp workspace invites cancel teammate@acme.com
  $ hookmyapp workspace invites cancel 3f4b1c4e-... --yes
`,
  );
}
