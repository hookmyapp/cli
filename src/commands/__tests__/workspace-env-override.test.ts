import { describe, it, expect, afterEach } from 'vitest';
import { switchActiveWorkspace, effectiveActiveWorkspaceId, markActiveWorkspaceId } from '../workspace.js';
import { ValidationError } from '../../output/error.js';

// AIT-438: HOOKMYAPP_WORKSPACE_ID outranks the persisted selection, so a
// `workspace use` that "succeeds" would send the next command at the old
// workspace. Refuse instead of lying.
describe('workspace use under HOOKMYAPP_WORKSPACE_ID', () => {
  const original = process.env.HOOKMYAPP_WORKSPACE_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.HOOKMYAPP_WORKSPACE_ID;
    else process.env.HOOKMYAPP_WORKSPACE_ID = original;
  });

  it('refuses the switch while the override is set', async () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_abc12345';
    await expect(switchActiveWorkspace('some-other-ws')).rejects.toThrow(ValidationError);
    await expect(switchActiveWorkspace('some-other-ws')).rejects.toThrow(
      /HOOKMYAPP_WORKSPACE_ID is set to ws_abc12345/,
    );
  });

  it('refuses `customers use` the same way', async () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_abc12345';
    await expect(
      switchActiveWorkspace('some-customer', { kind: 'customer' }),
    ).rejects.toThrow(ValidationError);
  });
});

// Status surfaces (customers list/current, doctor) must describe the workspace
// commands actually use, not the persisted one the override supersedes.
describe('effectiveActiveWorkspaceId', () => {
  const original = process.env.HOOKMYAPP_WORKSPACE_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.HOOKMYAPP_WORKSPACE_ID;
    else process.env.HOOKMYAPP_WORKSPACE_ID = original;
  });

  it('prefers the environment override', () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_env12345';
    expect(effectiveActiveWorkspaceId()).toBe('ws_env12345');
  });

  it('treats a quoted-empty value as unset', () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = '""';
    expect(effectiveActiveWorkspaceId()).not.toBe('""');
  });
});

// Telemetry must tag events with the workspace the request targeted, which is
// the flag when one was passed — not the environment override it outranks.
describe('telemetry workspace attribution', () => {
  const original = process.env.HOOKMYAPP_WORKSPACE_ID;
  afterEach(async () => {
    if (original === undefined) delete process.env.HOOKMYAPP_WORKSPACE_ID;
    else process.env.HOOKMYAPP_WORKSPACE_ID = original;
    const { setWorkspaceContext } = await import('../../config/workspace-context.js');
    setWorkspaceContext({ workspaceId: null });
  });

  it('prefers the workspace resolved for the invocation over the env value', async () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_envAAAAA';
    const { setWorkspaceContext } = await import('../../config/workspace-context.js');
    const { readActiveWorkspacePublicId } = await import('../../config/index.js');

    setWorkspaceContext({ workspaceId: 'ws_flagBBBB' });
    expect(readActiveWorkspacePublicId()).toBe('ws_flagBBBB');
  });

  it('falls back to the env value when nothing was resolved', async () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_envAAAAA';
    const { readActiveWorkspacePublicId } = await import('../../config/index.js');
    expect(readActiveWorkspacePublicId()).toBe('ws_envAAAAA');
  });
});

// --workspace outranks the env override for the invocation, so a status
// surface that ignores it stars a workspace the command is not using.
describe('markActiveWorkspaceId', () => {
  const original = process.env.HOOKMYAPP_WORKSPACE_ID;
  const all = [
    { id: 'ws_env12345', name: 'EnvSpace' },
    { id: 'ws_flag1234', name: 'FlagSpace' },
  ];
  afterEach(() => {
    if (original === undefined) delete process.env.HOOKMYAPP_WORKSPACE_ID;
    else process.env.HOOKMYAPP_WORKSPACE_ID = original;
  });

  it('resolves the flag by name against the fetched list', () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_env12345';
    expect(markActiveWorkspaceId(all, 'FlagSpace')).toBe('ws_flag1234');
    expect(markActiveWorkspaceId(all, 'ws_flag1234')).toBe('ws_flag1234');
  });

  it('falls back to the effective workspace with no flag', () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_env12345';
    expect(markActiveWorkspaceId(all)).toBe('ws_env12345');
  });

  it('ignores a flag that matches nothing in the list', () => {
    process.env.HOOKMYAPP_WORKSPACE_ID = 'ws_env12345';
    expect(markActiveWorkspaceId(all, 'nope')).toBe('ws_env12345');
  });
});
