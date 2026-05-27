// `hookmyapp sandbox status` — list active sandbox sessions.
//
// Display: cli-table3 with Type | Identifier | Status columns.
// Identifier is +phone for WA, @username for IG (falls back to IGSID per
// sessionIdentifier()). The Listener column was dropped along with
// lastHeartbeatAt (Phase A — heartbeat is now internal-only DB state, not on
// the wire).
//
// JSON mode emits a HAND-PICKED projection of SandboxSession (see
// toStatusJson) — NOT the raw wire DTO. Reasons:
//   - hmacSecret + accessToken are sensitive (VERIFY_TOKEN + per-session
//     proxy token); they're already reachable via `sandbox env` for code
//     that needs to wire up an app, but they have no business on a
//     `list sessions` surface.
//   - cloudflareTunnelToken is internal infra; should never leave the
//     backend, let alone leak through a customer-facing CLI command.
//   - origin / lastDemoRefreshPromptAt / claimTokenHash / createdAt /
//     updatedAt / workspaceName / activatedAt are backend metadata with
//     no CLI value.
//   - whatsappPhone:null / senderInstagramId:null discriminated-union
//     nulls clutter every IG row with WA-shape fields and vice versa.

import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
  type SandboxSession,
} from '../../api/sandbox-session.js';
import { renderTable } from '../../output/table.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { sessionIdentifier } from './helpers.js';

interface StatusJsonRow {
  id: string;
  type: 'whatsapp' | 'instagram';
  identifier: string;
  status: SandboxSession['status'];
  webhookUrl: string | null;
  // Channel-specific wire ids — only the fields applicable to the row's type
  // appear; the other channel's keys are omitted (no `whatsappPhone: null`
  // clutter on IG rows).
  whatsappPhone?: string;
  whatsappPhoneNumberId?: string;
  senderInstagramUsername?: string | null;
  senderInstagramId?: string;
  accountInstagramId?: string;
}

function toStatusJson(s: SandboxSession): StatusJsonRow {
  const base: StatusJsonRow = {
    id: s.id,
    type: s.type,
    identifier: sessionIdentifier(s),
    status: s.status,
    webhookUrl: s.webhookUrl ?? null,
  };
  switch (s.type) {
    case 'whatsapp':
      return {
        ...base,
        whatsappPhone: s.whatsappPhone,
        whatsappPhoneNumberId: s.whatsappPhoneNumberId,
      };
    case 'instagram':
      return {
        ...base,
        senderInstagramUsername: s.senderInstagramUsername,
        senderInstagramId: s.senderInstagramId,
        accountInstagramId: s.accountInstagramId,
      };
  }
}

export async function runSandboxStatus(opts: { json?: boolean } = {}): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions', { workspaceId });
  const sessions: SandboxSession[] = parseSandboxSessions(dto);

  if (opts.json) {
    process.stdout.write(JSON.stringify(sessions.map(toStatusJson), null, 2) + '\n');
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
  }));
  process.stdout.write(renderTable(rows) + '\n');
}
