import type { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { addExamples } from '../output/help.js';
import { gatewayRequest, gatewayUpload } from '../api/gateway.js';
import { resolveChannelRefOrDefault } from './_helpers.js';
import { isJsonMode } from '../output/format.js';
import { ValidationError } from '../output/error.js';

// Meta limits (AIT-290 spec). Mirrors backend channel-actions/whatsapp/groups.service.ts.
// Limits count Unicode code points (characters), not UTF-16 units: an emoji is one.
const SUBJECT_MAX = 128;
const DESCRIPTION_MAX = 2048;
const MEMBERS_MAX = 8;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const GROUP_ID = /^[A-Za-z0-9+=_-]{1,256}$/;
const MP = { messaging_product: 'whatsapp' } as const;
const APPROVAL_MODES: Record<string, string> = { auto: 'auto_approve', required: 'approval_required' };
const INFO_FIELDS =
  'subject,description,participants,join_approval_mode,suspended,creation_timestamp,total_participant_count';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

interface ChannelOpt {
  channel?: string;
}

/** The group id goes in the path unencoded, so anything outside the grammar (slash, `?`, `..`) must never reach it. */
function assertGroupId(id: string): string {
  if (typeof id !== 'string' || !GROUP_ID.test(id)) {
    throw new ValidationError(
      'Invalid group id. Use the id from `whatsapp groups list` (letters, digits, + = _ -).',
      'INVALID_GROUP_ID',
    );
  }
  return id;
}

function assertSubject(subject: unknown): string {
  if (typeof subject !== 'string' || subject.trim() === '' || [...subject].length > SUBJECT_MAX) {
    throw new ValidationError(`--subject must be 1 to ${SUBJECT_MAX} characters.`, 'INVALID_SUBJECT');
  }
  return subject;
}

function assertDescription(description: unknown): string {
  if (typeof description !== 'string' || [...description].length > DESCRIPTION_MAX) {
    throw new ValidationError(`--description can be up to ${DESCRIPTION_MAX} characters.`, 'INVALID_DESCRIPTION');
  }
  return description;
}

/** Phone numbers and wa_ids go as `user`, digits only without the `+` (the wa_id form); anything else is a BSUID, sent as `user_id` (same rule as the REST API). */
function participantOf(member: string): { user: string } | { user_id: string } {
  const m = typeof member === 'string' ? member.trim() : '';
  if (m === '') throw new ValidationError('Each member must be a phone number, WhatsApp id or user id.', 'INVALID_MEMBER');
  const phone = m.replace(/[\s()-]/g, '');
  return /^\+?\d+$/.test(phone) ? { user: phone.replace(/^\+/, '') } : { user_id: m };
}

function print(res: unknown, cmd: Command | undefined, human: () => string): void {
  process.stdout.write((cmd && isJsonMode(cmd) ? JSON.stringify(res) : human()) + '\n');
}

function nextCursor(res: Obj): string | undefined {
  const paging = obj(res.paging);
  return paging.next ? str(obj(paging.cursors).after) : undefined;
}

// ---- create ---------------------------------------------------------------

export interface WaGroupsCreateOpts extends ChannelOpt {
  subject?: string;
  description?: string;
  approval?: string;
}

export async function runWhatsappGroupsCreate(opts: WaGroupsCreateOpts, cmd?: Command): Promise<void> {
  const subject = assertSubject(opts.subject);
  const description = opts.description === undefined ? undefined : assertDescription(opts.description);
  if (opts.approval !== undefined && !Object.hasOwn(APPROVAL_MODES, opts.approval)) {
    throw new ValidationError('--approval must be "auto" or "required".', 'INVALID_APPROVAL');
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayRequest({
    channel,
    method: 'POST',
    path: '/{phone_number_id}/groups',
    body: {
      ...MP,
      subject,
      ...(description !== undefined ? { description } : {}),
      ...(opts.approval !== undefined ? { join_approval_mode: APPROVAL_MODES[opts.approval] } : {}),
    },
  });
  print(res, cmd, () => {
    const id = str(obj(res).request_id);
    return id ? `Group requested. request_id=${id}` : 'Group requested.';
  });
}

// ---- list -----------------------------------------------------------------

export interface WaGroupsListOpts extends ChannelOpt {
  cursor?: string;
}

export async function runWhatsappGroupsList(opts: WaGroupsListOpts, cmd?: Command): Promise<void> {
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const query = opts.cursor ? `?${new URLSearchParams({ after: opts.cursor })}` : '';
  const res = await gatewayRequest({ channel, method: 'GET', path: `/{phone_number_id}/groups${query}` });
  print(res, cmd, () => {
    // Meta nests the list: data.groups[], not data[].
    const groups = arr(obj(obj(res).data).groups);
    if (groups.length === 0) return 'No groups yet.';
    const lines = groups.map((g) => `${str(obj(g).id) ?? ''}  ${str(obj(g).subject) ?? ''}`);
    const next = nextCursor(obj(res));
    if (next) lines.push(`More groups: --cursor ${next}`);
    return lines.join('\n');
  });
}

// ---- get ------------------------------------------------------------------

export async function runWhatsappGroupsGet(opts: ChannelOpt, groupId: string, cmd?: Command): Promise<void> {
  assertGroupId(groupId);
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayRequest({
    channel,
    method: 'GET',
    path: `/${groupId}?${new URLSearchParams({ fields: INFO_FIELDS })}`,
  });
  print(res, cmd, () => {
    const g = obj(res);
    const lines = [`${groupId}  ${str(g.subject) ?? ''}`];
    if (str(g.description)) lines.push(`Description: ${str(g.description)}`);
    if (str(g.join_approval_mode)) lines.push(`Join approval: ${str(g.join_approval_mode)}`);
    if (typeof g.total_participant_count === 'number') lines.push(`Members: ${g.total_participant_count}`);
    for (const p of arr(g.participants)) lines.push(`  ${str(obj(p).wa_id) ?? str(obj(p).user_id) ?? ''}`);
    return lines.join('\n');
  });
}

// ---- update ---------------------------------------------------------------

export interface WaGroupsUpdateOpts extends ChannelOpt {
  subject?: string;
  description?: string;
}

export async function runWhatsappGroupsUpdate(opts: WaGroupsUpdateOpts, groupId: string, cmd?: Command): Promise<void> {
  assertGroupId(groupId);
  if (opts.subject === undefined && opts.description === undefined) {
    throw new ValidationError('Pass --subject, --description, or both.', 'EMPTY_UPDATE');
  }
  const body = {
    ...MP,
    ...(opts.subject !== undefined ? { subject: assertSubject(opts.subject) } : {}),
    ...(opts.description !== undefined ? { description: assertDescription(opts.description) } : {}),
  };
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayRequest({ channel, method: 'POST', path: `/${groupId}`, body });
  print(res, cmd, () => 'Group update requested.');
}

// ---- photo ----------------------------------------------------------------

export interface WaGroupsPhotoOpts extends ChannelOpt {
  file?: string;
}

/** JPEG by magic bytes (FF D8 FF), within Meta's 5MB cap. Square and >=192px is left to Meta. */
async function assertJpegFile(file: string | undefined): Promise<string> {
  if (!file) throw new ValidationError('--file <path> is required (a JPEG up to 5MB).', 'MISSING_FILE');
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new ValidationError(`Cannot read ${file}.`, 'FILE_NOT_FOUND');
  }
  if (size > PHOTO_MAX_BYTES) throw new ValidationError('The group photo must be 5MB or smaller.', 'PHOTO_TOO_LARGE');
  const head = (await readFile(file)).subarray(0, 3);
  if (head.length < 3 || head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) {
    throw new ValidationError('The group photo must be a JPEG image.', 'PHOTO_NOT_JPEG');
  }
  return file;
}

export async function runWhatsappGroupsPhoto(opts: WaGroupsPhotoOpts, groupId: string, cmd?: Command): Promise<void> {
  assertGroupId(groupId);
  const file = await assertJpegFile(opts.file);
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  // Same multipart field name the REST API sends to Meta.
  const res = await gatewayUpload({
    channel,
    path: `/${groupId}`,
    file,
    type: 'image/jpeg',
    fileField: 'profile_picture_file',
  });
  print(res, cmd, () => 'Group photo update requested.');
}

// ---- delete ---------------------------------------------------------------

export async function runWhatsappGroupsDelete(opts: ChannelOpt, groupId: string, cmd?: Command): Promise<void> {
  assertGroupId(groupId);
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayRequest({ channel, method: 'DELETE', path: `/${groupId}` });
  // Meta reports the outcome later, in a group_lifecycle_update webhook.
  print(res, cmd, () => {
    const id = str(obj(res).request_id);
    return id ? `Group deletion requested. request_id=${id}` : 'Group deletion requested.';
  });
}

// ---- invite-link ----------------------------------------------------------

export interface WaGroupsInviteLinkOpts extends ChannelOpt {
  reset?: boolean;
  revoke?: boolean;
}

export async function runWhatsappGroupsInviteLink(
  opts: WaGroupsInviteLinkOpts,
  groupId: string,
  cmd?: Command,
): Promise<void> {
  assertGroupId(groupId);
  if (opts.reset && opts.revoke) {
    throw new ValidationError('Use --reset or --revoke, not both.', 'RESET_AND_REVOKE');
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const path = `/${groupId}/invite_link`;
  const res = await gatewayRequest({
    channel,
    path,
    ...(opts.revoke
      ? { method: 'DELETE', body: { ...MP } }
      : opts.reset
        ? { method: 'POST', body: { ...MP } }
        : { method: 'GET' }),
  });
  print(res, cmd, () => (opts.revoke ? 'Invite link revoked.' : (str(obj(res).invite_link) ?? 'Invite link reset.')));
}

// ---- remove ---------------------------------------------------------------

export async function runWhatsappGroupsRemove(
  opts: ChannelOpt,
  groupId: string,
  members: string[],
  cmd?: Command,
): Promise<void> {
  assertGroupId(groupId);
  if (!Array.isArray(members) || members.length === 0 || members.length > MEMBERS_MAX) {
    throw new ValidationError(`Pass 1 to ${MEMBERS_MAX} members to remove.`, 'INVALID_MEMBER_COUNT');
  }
  const participants = members.map(participantOf);
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const res = await gatewayRequest({
    channel,
    method: 'DELETE',
    path: `/${groupId}/participants`,
    body: { ...MP, participants },
  });
  print(res, cmd, () => 'Member removal requested.');
}

// ---- join-requests --------------------------------------------------------

export interface WaGroupsJoinRequestsOpts extends ChannelOpt {
  approve?: string[];
  reject?: string[];
}

export async function runWhatsappGroupsJoinRequests(
  opts: WaGroupsJoinRequestsOpts,
  groupId: string,
  cmd?: Command,
): Promise<void> {
  assertGroupId(groupId);
  if (opts.approve !== undefined && opts.reject !== undefined) {
    throw new ValidationError('Use --approve or --reject, not both.', 'APPROVE_AND_REJECT');
  }
  const ids = opts.approve ?? opts.reject;
  if (ids !== undefined && (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === ''))) {
    throw new ValidationError('Pass one or more join request ids.', 'MISSING_JOIN_REQUEST_IDS');
  }
  const channel = await resolveChannelRefOrDefault(opts.channel, 'whatsapp');
  const path = `/${groupId}/join_requests`;
  if (ids === undefined) {
    const res = await gatewayRequest({ channel, method: 'GET', path });
    print(res, cmd, () => {
      const rows = arr(obj(res).data);
      if (rows.length === 0) return 'No join requests.';
      return rows.map((r) => `${str(obj(r).join_request_id) ?? ''}  ${str(obj(r).wa_id) ?? ''}`).join('\n');
    });
    return;
  }
  const approving = opts.approve !== undefined;
  const res = await gatewayRequest({
    channel,
    method: approving ? 'POST' : 'DELETE',
    path,
    body: { ...MP, join_requests: ids },
  });
  print(res, cmd, () => {
    const failed = arr(obj(res).failed_join_requests).length;
    const verb = approving ? 'approval' : 'rejection';
    return failed > 0 ? `Join request ${verb} requested. ${failed} failed (see --json).` : `Join request ${verb} requested.`;
  });
}

// ---- registration ---------------------------------------------------------

const CHANNEL_FLAG = '--channel <ref>';
const CHANNEL_DESC = 'Channel: phone number, @handle, or ch_id (defaults to HOOKMYAPP_CHANNEL_ID)';

/** Registers `whatsapp groups create|list|get|update|photo|delete|invite-link|remove|join-requests`. */
export function registerWhatsappGroups(whatsapp: Command): void {
  const groups = whatsapp
    .command('groups')
    .description('Create and manage WhatsApp groups (Official Business Account numbers on the Cloud API)');

  addExamples(
    groups,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups create --channel 1555 --subject "Team" --approval required
  $ hookmyapp whatsapp groups list --channel 1555
  $ hookmyapp whatsapp groups invite-link GROUP_ID --channel 1555
`,
  );

  const createCmd = groups
    .command('create')
    .description('Create a group')
    .requiredOption('--subject <text>', `Group subject (1 to ${SUBJECT_MAX} characters)`)
    .option('--description <text>', `Group description (up to ${DESCRIPTION_MAX} characters)`)
    .option('--approval <mode>', 'Join approval: auto or required')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, opts: WaGroupsCreateOpts) {
      await runWhatsappGroupsCreate(opts, this);
    });

  const listCmd = groups
    .command('list')
    .description('List groups')
    .option('--cursor <cursor>', 'Page cursor from a previous list')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, opts: WaGroupsListOpts) {
      await runWhatsappGroupsList(opts, this);
    });

  const getCmd = groups
    .command('get')
    .description('Show a group and its members')
    .argument('<groupId>', 'Group id')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, opts: ChannelOpt) {
      await runWhatsappGroupsGet(opts, groupId, this);
    });

  const updateCmd = groups
    .command('update')
    .description('Change a group subject or description')
    .argument('<groupId>', 'Group id')
    .option('--subject <text>', `New subject (1 to ${SUBJECT_MAX} characters)`)
    .option('--description <text>', `New description (up to ${DESCRIPTION_MAX} characters)`)
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, opts: WaGroupsUpdateOpts) {
      await runWhatsappGroupsUpdate(opts, groupId, this);
    });

  const photoCmd = groups
    .command('photo')
    .description('Set the group photo (JPEG, square, at least 192px, up to 5MB)')
    .argument('<groupId>', 'Group id')
    .option('--file <path>', 'Path to the JPEG')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, opts: WaGroupsPhotoOpts) {
      await runWhatsappGroupsPhoto(opts, groupId, this);
    });

  const deleteCmd = groups
    .command('delete')
    .description('Delete a group')
    .argument('<groupId>', 'Group id')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, opts: ChannelOpt) {
      await runWhatsappGroupsDelete(opts, groupId, this);
    });

  const invitelinkCmd = groups
    .command('invite-link')
    .description('Show a group invite link (or reset / revoke it)')
    .argument('<groupId>', 'Group id')
    .option('--reset', 'Replace the link with a new one')
    .option('--revoke', 'Revoke the link')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, opts: WaGroupsInviteLinkOpts) {
      await runWhatsappGroupsInviteLink(opts, groupId, this);
    });

  const removeCmd = groups
    .command('remove')
    .description(`Remove members from a group (1 to ${MEMBERS_MAX})`)
    .argument('<groupId>', 'Group id')
    .argument('<member...>', 'Phone number, WhatsApp id or user id')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, members: string[], opts: ChannelOpt) {
      await runWhatsappGroupsRemove(opts, groupId, members, this);
    });

  const joinrequestsCmd = groups
    .command('join-requests')
    .description('List join requests, or approve / reject them')
    .argument('<groupId>', 'Group id')
    .option('--approve <id...>', 'Approve these join request ids')
    .option('--reject <id...>', 'Reject these join request ids')
    .option(CHANNEL_FLAG, CHANNEL_DESC)
    .action(async function (this: Command, groupId: string, opts: WaGroupsJoinRequestsOpts) {
      await runWhatsappGroupsJoinRequests(opts, groupId, this);
    });

  addExamples(
    createCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups create --channel 1555 --subject "Team" --approval required
  $ hookmyapp whatsapp groups create --channel 1555 --subject "Team" --description "Order updates" --approval auto
`,
  );

  addExamples(
    listCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups list --channel 1555
  $ hookmyapp whatsapp groups list --channel 1555 --json
`,
  );

  addExamples(
    getCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups get GROUP_ID --channel 1555
  $ hookmyapp whatsapp groups get GROUP_ID --channel 1555 --json
`,
  );

  addExamples(
    updateCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups update GROUP_ID --channel 1555 --subject "New name"
  $ hookmyapp whatsapp groups update GROUP_ID --channel 1555 --description "New description"
`,
  );

  addExamples(
    photoCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups photo GROUP_ID --channel 1555 --file ./group.jpg
  $ hookmyapp whatsapp groups photo GROUP_ID --channel 1555 --file ./group.jpg --json
`,
  );

  addExamples(
    deleteCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups delete GROUP_ID --channel 1555
  $ hookmyapp whatsapp groups delete GROUP_ID --channel 1555 --json
`,
  );

  addExamples(
    invitelinkCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups invite-link GROUP_ID --channel 1555 --reset
  $ hookmyapp whatsapp groups invite-link GROUP_ID --channel 1555
`,
  );

  addExamples(
    removeCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups remove GROUP_ID +15551234567 --channel 1555
  $ hookmyapp whatsapp groups remove GROUP_ID +15551234567 +15557654321 --channel 1555
`,
  );

  addExamples(
    joinrequestsCmd,
    `
EXAMPLES:
  $ hookmyapp whatsapp groups join-requests GROUP_ID --channel 1555 --approve REQUEST_ID
  $ hookmyapp whatsapp groups join-requests GROUP_ID --channel 1555
`,
  );
}
