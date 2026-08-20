import { describe, it, expect, afterEach } from 'vitest';
import { switchActiveWorkspace } from '../workspace.js';
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
