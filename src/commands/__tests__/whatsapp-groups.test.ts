import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../../api/gateway.js', () => ({
  gatewayRequest: vi.fn(async () => ({})),
  gatewayUpload: vi.fn(async () => ({ success: true })),
}));
vi.mock('../_helpers.js', () => ({
  resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })),
}));

import {
  runWhatsappGroupsCreate,
  runWhatsappGroupsList,
  runWhatsappGroupsGet,
  runWhatsappGroupsUpdate,
  runWhatsappGroupsPhoto,
  runWhatsappGroupsDelete,
  runWhatsappGroupsInviteLink,
  runWhatsappGroupsRemove,
  runWhatsappGroupsJoinRequests,
} from '../whatsapp-groups.js';
import { gatewayRequest, gatewayUpload } from '../../api/gateway.js';
import { ValidationError } from '../../output/error.js';

const G = 'Y2Fyb3VzZWw=_-+';
const last = () => vi.mocked(gatewayRequest).mock.calls[0][0];
let out: string[];

beforeEach(() => {
  vi.mocked(gatewayRequest).mockReset().mockResolvedValue({});
  vi.mocked(gatewayUpload).mockClear();
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('whatsapp groups', () => {
  it('create: POST /{phone_number_id}/groups with Meta body, approval mapped', async () => {
    await runWhatsappGroupsCreate({ subject: 'Team', description: 'd', approval: 'required' });
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/{phone_number_id}/groups',
      body: { messaging_product: 'whatsapp', subject: 'Team', description: 'd', join_approval_mode: 'approval_required' },
    });
  });

  it('create: omits optional fields; auto maps to auto_approve', async () => {
    await runWhatsappGroupsCreate({ subject: 'Team' });
    expect(last().body).toEqual({ messaging_product: 'whatsapp', subject: 'Team' });
    vi.mocked(gatewayRequest).mockClear();
    await runWhatsappGroupsCreate({ subject: 'Team', approval: 'auto' });
    expect(last().body).toMatchObject({ join_approval_mode: 'auto_approve' });
  });

  it('create: counts the subject in characters, 128 emoji pass and 129 fail', async () => {
    await runWhatsappGroupsCreate({ subject: '😀'.repeat(128) });
    await expect(runWhatsappGroupsCreate({ subject: '😀'.repeat(129) })).rejects.toBeInstanceOf(ValidationError);
  });

  it('create: rejects a 129-char subject, bad description, bad approval before any call', async () => {
    await expect(runWhatsappGroupsCreate({ subject: 'x'.repeat(129) })).rejects.toBeInstanceOf(ValidationError);
    await expect(runWhatsappGroupsCreate({ subject: '' })).rejects.toBeInstanceOf(ValidationError);
    await expect(runWhatsappGroupsCreate({ subject: 's', description: 'x'.repeat(2049) })).rejects.toBeInstanceOf(ValidationError);
    await expect(runWhatsappGroupsCreate({ subject: 's', approval: 'maybe' })).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('create: accepts 128-char subject and 2048-char description', async () => {
    await runWhatsappGroupsCreate({ subject: 'x'.repeat(128), description: 'y'.repeat(2048) });
    expect(gatewayRequest).toHaveBeenCalledTimes(1);
  });

  it('list: GET /{phone_number_id}/groups, cursor goes as after', async () => {
    await runWhatsappGroupsList({});
    expect(last()).toMatchObject({ method: 'GET', path: '/{phone_number_id}/groups' });
    vi.mocked(gatewayRequest).mockClear();
    await runWhatsappGroupsList({ cursor: 'abc=' });
    expect(last().path).toBe('/{phone_number_id}/groups?after=abc%3D');
  });

  it('list: human output is one line per group (data.groups[])', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: { groups: [{ id: 'g1', subject: 'One' }, { id: 'g2', subject: 'Two' }] } });
    await runWhatsappGroupsList({});
    expect(out.join('')).toBe('g1  One\ng2  Two\n');
  });

  it('list: empty state line', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: { groups: [] } });
    await runWhatsappGroupsList({});
    expect(out.join('')).toContain('No groups yet.');
  });

  it('get: GET /{group}?fields=...', async () => {
    await runWhatsappGroupsGet({}, G);
    expect(last().method).toBe('GET');
    expect(last().path).toBe(`/${G}?fields=subject%2Cdescription%2Cparticipants%2Cjoin_approval_mode%2Csuspended%2Ccreation_timestamp%2Ctotal_participant_count`);
  });

  it('update: POST /{group} with subject/description; empty update rejected', async () => {
    await runWhatsappGroupsUpdate({ subject: 'New' }, G);
    expect(last()).toMatchObject({ method: 'POST', path: `/${G}`, body: { messaging_product: 'whatsapp', subject: 'New' } });
    vi.mocked(gatewayRequest).mockClear();
    await expect(runWhatsappGroupsUpdate({}, G)).rejects.toBeInstanceOf(ValidationError);
    await expect(runWhatsappGroupsUpdate({ subject: 'x'.repeat(129) }, G)).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('delete: DELETE /{group}', async () => {
    await runWhatsappGroupsDelete({}, G);
    expect(last()).toMatchObject({ method: 'DELETE', path: `/${G}` });
  });

  it('invite-link: GET by default, POST to reset, DELETE to revoke (with messaging_product)', async () => {
    await runWhatsappGroupsInviteLink({}, G);
    expect(last()).toMatchObject({ method: 'GET', path: `/${G}/invite_link` });
    vi.mocked(gatewayRequest).mockClear();
    await runWhatsappGroupsInviteLink({ reset: true }, G);
    expect(last()).toMatchObject({ method: 'POST', path: `/${G}/invite_link`, body: { messaging_product: 'whatsapp' } });
    vi.mocked(gatewayRequest).mockClear();
    await runWhatsappGroupsInviteLink({ revoke: true }, G);
    expect(last()).toMatchObject({ method: 'DELETE', path: `/${G}/invite_link`, body: { messaging_product: 'whatsapp' } });
  });

  it('invite-link: --reset with --revoke throws before any call', async () => {
    await expect(runWhatsappGroupsInviteLink({ reset: true, revoke: true }, G)).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('invite-link: human output prints the link', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ invite_link: 'https://chat.whatsapp.com/abc' });
    await runWhatsappGroupsInviteLink({}, G);
    expect(out.join('')).toBe('https://chat.whatsapp.com/abc\n');
  });

  it('remove: DELETE /{group}/participants, phones as user, others as user_id', async () => {
    await runWhatsappGroupsRemove({}, G, ['+1 555 123 4567', '15550001111', 'US.abc123']);
    expect(last()).toMatchObject({
      method: 'DELETE',
      path: `/${G}/participants`,
      body: { messaging_product: 'whatsapp', participants: [{ user: '+1 555 123 4567' }, { user: '15550001111' }, { user_id: 'US.abc123' }] },
    });
  });

  it('remove: 9 members or 0 members throw before any call', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `1555000000${i}`);
    await expect(runWhatsappGroupsRemove({}, G, nine)).rejects.toBeInstanceOf(ValidationError);
    await expect(runWhatsappGroupsRemove({}, G, [])).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('join-requests: GET list by default', async () => {
    await runWhatsappGroupsJoinRequests({}, G);
    expect(last()).toMatchObject({ method: 'GET', path: `/${G}/join_requests` });
  });

  it('join-requests: --approve POSTs, --reject DELETEs, with join_requests ids', async () => {
    await runWhatsappGroupsJoinRequests({ approve: ['r1', 'r2'] }, G);
    expect(last()).toMatchObject({ method: 'POST', path: `/${G}/join_requests`, body: { messaging_product: 'whatsapp', join_requests: ['r1', 'r2'] } });
    vi.mocked(gatewayRequest).mockClear();
    await runWhatsappGroupsJoinRequests({ reject: ['r3'] }, G);
    expect(last()).toMatchObject({ method: 'DELETE', path: `/${G}/join_requests`, body: { messaging_product: 'whatsapp', join_requests: ['r3'] } });
  });

  it('join-requests: --approve with --reject throws; 9+ ids is fine only if non-empty', async () => {
    await expect(runWhatsappGroupsJoinRequests({ approve: ['a'], reject: ['b'] }, G)).rejects.toBeInstanceOf(ValidationError);
    await expect(runWhatsappGroupsJoinRequests({ approve: [] }, G)).rejects.toBeInstanceOf(ValidationError);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('join-requests: human list prints one line per request', async () => {
    vi.mocked(gatewayRequest).mockResolvedValue({ data: [{ join_request_id: 'r1', wa_id: '1555' }] });
    await runWhatsappGroupsJoinRequests({}, G);
    expect(out.join('')).toBe('r1  1555\n');
  });

  it.each([
    ['get', (id: string) => runWhatsappGroupsGet({}, id)],
    ['update', (id: string) => runWhatsappGroupsUpdate({ subject: 's' }, id)],
    ['delete', (id: string) => runWhatsappGroupsDelete({}, id)],
    ['invite-link', (id: string) => runWhatsappGroupsInviteLink({}, id)],
    ['remove', (id: string) => runWhatsappGroupsRemove({}, id, ['1555'])],
    ['join-requests', (id: string) => runWhatsappGroupsJoinRequests({}, id)],
    ['photo', (id: string) => runWhatsappGroupsPhoto({ file: '/nope.jpg' }, id)],
  ])('%s: group id outside the grammar is rejected before any call', async (_n, run) => {
    for (const bad of ['a/b', '', 'a b', '../x', 'x?y=1', 'a'.repeat(257)]) {
      await expect(run(bad)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(gatewayUpload).not.toHaveBeenCalled();
  });

  it('--json prints the raw Meta response untouched', async () => {
    const raw = { data: { groups: [{ id: 'g1', subject: 'One' }] }, paging: { cursors: { after: 'x' } } };
    vi.mocked(gatewayRequest).mockResolvedValue(raw);
    const cmd = { optsWithGlobals: () => ({ json: true }), parent: undefined } as never;
    await runWhatsappGroupsList({}, cmd);
    expect(JSON.parse(out.join(''))).toEqual(raw);
  });

  describe('photo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grp-'));
    const jpg = join(dir, 'a.jpg');
    writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));

    it('uploads the JPEG to /{group} as profile_picture_file', async () => {
      await runWhatsappGroupsPhoto({ file: jpg }, G);
      expect(gatewayUpload).toHaveBeenCalledWith(expect.objectContaining({
        path: `/${G}`, file: jpg, type: 'image/jpeg', fileField: 'profile_picture_file',
      }));
    });

    it('rejects a missing --file, a non-JPEG, and a file over 5MB before any upload', async () => {
      await expect(runWhatsappGroupsPhoto({}, G)).rejects.toBeInstanceOf(ValidationError);
      const png = join(dir, 'a.png');
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await expect(runWhatsappGroupsPhoto({ file: png }, G)).rejects.toBeInstanceOf(ValidationError);
      const big = join(dir, 'big.jpg');
      writeFileSync(big, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(5 * 1024 * 1024)]));
      await expect(runWhatsappGroupsPhoto({ file: big }, G)).rejects.toBeInstanceOf(ValidationError);
      await expect(runWhatsappGroupsPhoto({ file: join(dir, 'missing.jpg') }, G)).rejects.toBeInstanceOf(ValidationError);
      expect(gatewayUpload).not.toHaveBeenCalled();
    });
  });
});
