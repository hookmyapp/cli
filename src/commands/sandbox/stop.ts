// `hookmyapp sandbox stop` — delete a sandbox session.
//
// Generalizes today's phone-keyed picker to accept --phone / --username /
// --session uniformly. No channel-specific behavior beyond the picker — the
// DELETE endpoint is type-agnostic.

import { confirm } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
} from '../../api/sandbox-session.js';
import { c, icon } from '../../output/color.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { pickSession } from './picker.js';
import { sessionLabel } from './helpers.js';

export async function runSandboxStop(opts: {
  phone?: string;
  username?: string;
  session?: string;
  yes?: boolean;
  json?: boolean;
}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const isHuman = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    phoneFlag: opts.phone,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman,
    alwaysShowPicker: true,
  });

  if (!opts.yes && isHuman) {
    const ok = await confirm({
      message: `Delete ${sessionLabel(session)}?`,
      default: false,
    });
    if (!ok) return;
  }

  await apiClient(`/sandbox/sessions/${session.id}`, {
    method: 'DELETE',
    workspaceId,
  });

  console.log(`${c.success(icon.success)} Deleted ${sessionLabel(session)}`);
}
