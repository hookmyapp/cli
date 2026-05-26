// Session picker for `hookmyapp sandbox listen`.
//
// Contract (107-CONTEXT.md §CLI Flow Step 5):
//   0 sessions → throw NO_ACTIVE_SESSIONS (exit 2)
//   1 session → return silently (auto-select)
//   2+ + no flag + human TTY → interactive @inquirer/prompts select
//   --phone / --username / --session flag → exact match or SESSION_MISMATCH (exit 2) — NO fallback
//     to interactive (CI must be deterministic).

import { pickSession as unifiedPick } from '../sandbox/picker.js';
import { sessionIdentifier } from '../sandbox/helpers.js';
import { renderTable } from '../../output/table.js';
import { c } from '../../output/color.js';
import { ValidationError } from '../../output/error.js';
import { select } from '@inquirer/prompts';
import type { SandboxSession } from '../../api/sandbox-session.js';

export type Session = SandboxSession;

export interface PickSessionArgs {
  sessions: Session[];
  identifierArg?: string;
  phoneFlag?: string;
  usernameFlag?: string;
  sessionFlag?: string;
  isHuman: boolean;
}

export async function pickSession(args: PickSessionArgs): Promise<Session> {
  return unifiedPick({
    sessions: args.sessions,
    identifierArg: args.identifierArg,
    phoneFlag: args.phoneFlag,
    usernameFlag: args.usernameFlag,
    sessionFlag: args.sessionFlag,
    isHuman: args.isHuman,
  });
}

/**
 * Derive the "state" column from lastHeartbeatAt:
 *   null              → "idle"
 *   within last 2min  → "listening elsewhere (Xs ago)"
 *   older             → "idle (last tunnel Xh ago)" or "Xm ago"
 */
export function deriveState(lastHeartbeatAt: string | null | undefined): string {
  if (!lastHeartbeatAt) return 'idle';
  const parsed = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(parsed)) return 'idle';
  const ageMs = Date.now() - parsed;
  if (ageMs < 0) return 'idle';
  if (ageMs < 120_000) {
    const sec = Math.max(1, Math.floor(ageMs / 1000));
    return `listening elsewhere (${sec}s ago)`;
  }
  return `idle (last tunnel ${formatAge(ageMs)} ago)`;
}

function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (hr >= 1) return `${hr}h`;
  return `${min}m`;
}

/**
 * Lightweight session picker used by `sandbox env` and `sandbox send`.
 *
 * Unlike `pickSession` (which drives the full sandbox-listen flow with
 * --session flag support + workspaceId/workspaceName fields), this helper
 * only needs the phone shortcut and multi-session select. The callers'
 * session shape is also looser — we accept any record with `id` + `phone`.
 */
export interface MinimalSession {
  id: string;
  phone: string | null;
  status: string;
}

export async function pickSessionByPhone<T extends MinimalSession>(
  sessions: T[],
  phoneFlag?: string,
): Promise<T> {
  if (sessions.length === 0) {
    throw new ValidationError(
      phoneFlag
        ? `No active sandbox sessions. Run: hookmyapp sandbox start --phone ${phoneFlag}`
        : 'No active sandbox sessions. Run: hookmyapp sandbox start --phone +<your-number>',
    );
  }
  if (phoneFlag) {
    const normalized = phoneFlag.replace(/^\+/, '');
    const match = sessions.find(
      (s) => s.phone && s.phone.replace(/^\+/, '') === normalized,
    );
    if (!match) {
      throw new ValidationError(
        `No sandbox session for ${phoneFlag}. Run: hookmyapp sandbox start --phone ${phoneFlag}`,
      );
    }
    return match;
  }
  if (sessions.length === 1) {
    return sessions[0];
  }
  return (await select<T>({
    message: 'Select a sandbox session',
    choices: sessions.map((s) => ({
      name: `+${s.phone ?? ''} (${s.status})`,
      value: s,
    })),
  })) as T;
}

/**
 * Render a cli-table3 table of sandbox sessions with Type | Identifier |
 * Status | Listener columns. Used as a preview header above the interactive
 * picker prompt.
 *
 * Listener state derived from `lastHeartbeatAt`:
 *   live (green, <90s)  → currently being listened to
 *   idle (dim, ≥90s)    → heartbeat seen but stale
 *   (empty)             → never listened to
 */
export function renderSessionTable(sessions: SandboxSession[]): string {
  return renderTable(
    sessions.map((s) => {
      const ts = s.lastHeartbeatAt ? Date.parse(s.lastHeartbeatAt) : NaN;
      const live = Number.isFinite(ts) && Date.now() - ts < 90_000;
      let listener = '';
      if (s.lastHeartbeatAt) listener = live ? c.success('live') : c.dim('idle');
      return {
        Type: s.type === 'whatsapp' ? 'WhatsApp' : 'Instagram',
        Identifier: sessionIdentifier(s),
        Status: s.status,
        Listener: listener,
      };
    }),
  );
}
