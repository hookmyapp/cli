// `hookmyapp sandbox status` — list active sandbox sessions.
//
// Display: cli-table3 with Type | Identifier | Status | Listener columns.
// Identifier is +phone for WA, @username for IG (falls back to IGSID per
// sessionIdentifier()). Listener column shows live/idle derived from
// lastHeartbeatAt — empty when never tunneled.

import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
  type SandboxSession,
} from '../../api/sandbox-session.js';
import { output } from '../../output/format.js';
import { c } from '../../output/color.js';
import { renderTable } from '../../output/table.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { sessionIdentifier } from './helpers.js';

function deriveListener(lastHeartbeatAt: string | null | undefined): string {
  if (!lastHeartbeatAt) return '';
  const ts = Date.parse(lastHeartbeatAt);
  if (!Number.isFinite(ts)) return '';
  const ageMs = Date.now() - ts;
  return ageMs < 90_000 ? c.success('live') : c.dim('idle');
}

export async function runSandboxStatus(opts: { json?: boolean } = {}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions', { workspaceId });
  const sessions: SandboxSession[] = parseSandboxSessions(dto);

  if (opts.json) {
    output(sessions, { json: true });
    return;
  }

  if (sessions.length === 0) {
    console.log('No active sandbox sessions. Run: hookmyapp sandbox start');
    return;
  }

  const rows = sessions.map((s) => ({
    Type: s.type === 'whatsapp' ? 'WhatsApp' : 'Instagram',
    Identifier: sessionIdentifier(s),
    Status: s.status,
    Listener: deriveListener(s.lastHeartbeatAt),
  }));
  process.stdout.write(renderTable(rows) + '\n');
}
