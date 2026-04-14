// Session picker for `hookmyapp sandbox listen`.
//
// Contract (107-CONTEXT.md §CLI Flow Step 5):
//   0 sessions → throw NO_ACTIVE_SESSIONS (exit 2)
//   1 session → return silently (auto-select)
//   2+ + no flag + human TTY → interactive @inquirer/prompts select
//   --phone / --session flag → exact match or SESSION_MISMATCH (exit 2) — NO fallback
//     to interactive (CI must be deterministic).

import { select } from '@inquirer/prompts';
import { CliError, ValidationError } from '../../output/error.js';
import { renderTable } from '../../output/table.js';
import { c } from '../../output/color.js';

export interface Session {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  phone: string | null;
  status: string;
  lastHeartbeatAt: string | null;
}

export interface PickSessionArgs {
  sessions: Session[];
  phoneFlag?: string;
  sessionFlag?: string;
  isHuman: boolean;
}

export async function pickSession(args: PickSessionArgs): Promise<Session> {
  const { sessions, phoneFlag, sessionFlag, isHuman } = args;

  // 0 sessions → hard exit 2.
  if (sessions.length === 0) {
    const err = new CliError(
      'No active sandbox sessions. Create one in the dashboard or via hookmyapp sandbox start.',
      'NO_ACTIVE_SESSIONS',
    );
    err.exitCode = 2;
    throw err;
  }

  // Flag-driven path (CI-friendly). Never falls back to picker on mismatch.
  if (phoneFlag || sessionFlag) {
    // Normalize phoneFlag: backend strips leading + before persisting, so
    // exact-match against stored phone must do the same.
    const normalizedPhone = phoneFlag?.replace(/^\+/, '');
    const match = sessions.find(
      (s) =>
        (normalizedPhone &&
          s.phone &&
          s.phone.replace(/^\+/, '') === normalizedPhone) ||
        (sessionFlag && s.id === sessionFlag),
    );
    if (!match) {
      const needle = phoneFlag
        ? `--phone=${phoneFlag}`
        : `--session=${sessionFlag}`;
      const err = new CliError(
        `No active session matches ${needle}. Run hookmyapp sandbox status to list.`,
        'SESSION_MISMATCH',
      );
      err.exitCode = 2;
      throw err;
    }
    return match;
  }

  // Single session → silent auto-select.
  if (sessions.length === 1) {
    return sessions[0];
  }

  // 2+ sessions, no flag. In non-human (--json / piped) mode we still need a
  // pick, but without a flag it's ambiguous — surface the same mismatch error.
  if (!isHuman) {
    const err = new CliError(
      'Multiple active sessions. Disambiguate with --phone or --session (required in --json mode).',
      'SESSION_MISMATCH',
    );
    err.exitCode = 2;
    throw err;
  }

  // Interactive picker. Preview the sessions as a cli-table3 table above
  // the select prompt so users see phone + status + Listener state at a
  // glance (the one-line choice strings are harder to scan).
  process.stdout.write(renderSessionTable(sessions) + '\n');
  return select<Session>({
    message: 'Choose session',
    choices: sessions.map((s) => ({
      name: renderRow(s),
      value: s,
    })),
  });
}

/** Format one picker row: "Test phone · Workspace · State". */
function renderRow(s: Session): string {
  const phone = s.phone ?? '(no phone)';
  const workspace = s.workspaceName ?? s.workspaceId;
  return `${phone}   ${workspace}   ${deriveState(s.lastHeartbeatAt)}`;
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
 * Render a cli-table3 table of sandbox sessions with a "Listener" state
 * column derived from `lastHeartbeatAt`:
 *   live (green, <90s)  → currently being listened to
 *   idle (dim, ≥90s)    → heartbeat seen but stale
 *   (empty)             → never listened to
 *
 * Used as a preview header above the interactive picker prompt.
 */
export function renderSessionTable(
  sessions: Array<{
    phone: string | null;
    status: string;
    lastHeartbeatAt?: string | null;
  }>,
): string {
  return renderTable(
    sessions.map((s) => {
      const ts = s.lastHeartbeatAt ? Date.parse(s.lastHeartbeatAt) : NaN;
      const live = Number.isFinite(ts) && Date.now() - ts < 90_000;
      let listener = '';
      if (s.lastHeartbeatAt) {
        listener = live ? c.success('live') : c.dim('idle');
      }
      return {
        Phone: s.phone ? `+${s.phone.replace(/^\+/, '')}` : '',
        Status: s.status,
        Listener: listener,
      };
    }),
  );
}
