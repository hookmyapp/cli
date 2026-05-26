// Unified sandbox session picker. Replaces today's three pickers
// (pickSessionByPhone in sandbox.ts, the local pickSendSession also in
// sandbox.ts, and the WA-only matching logic in sandbox-listen/picker.ts —
// which Task 12 generalizes to call this function).
//
// D3 contract:
//   - at most one of --phone / --username / --session may be set
//   - selector value implies channel type (no --type flag for selection)
//   - mismatch / conflict → CliError + exitCode=2 (SESSION_MISMATCH or
//     CONFLICTING_SELECTORS); preserves the existing sandbox-listen pattern
//     used at sandbox-listen/picker.ts:60-66

import { select } from '@inquirer/prompts';
import {
  CliError,
  ValidationError,
} from '../../output/error.js';
import { sessionIdentifier, sessionLabel } from './helpers.js';
import type { SandboxSession } from '../../api/sandbox-session.js';

export interface PickSessionArgs {
  sessions: SandboxSession[];
  phoneFlag?: string;
  usernameFlag?: string;
  sessionFlag?: string;
  isHuman: boolean;
  /**
   * When true (used by `sandbox send`), always show the interactive picker
   * even with a single session. Forces the user to confirm the sender,
   * preventing accidental sends from the wrong test session.
   */
  alwaysShowPicker?: boolean;
}

export async function pickSession(args: PickSessionArgs): Promise<SandboxSession> {
  const { sessions, phoneFlag, usernameFlag, sessionFlag, isHuman, alwaysShowPicker } = args;

  // 1. Conflict check: at most one selector flag.
  const flagsSet = [phoneFlag, usernameFlag, sessionFlag].filter((f) => f !== undefined).length;
  if (flagsSet > 1) {
    throw new ValidationError(
      'Conflicting selectors. Provide at most one of --phone, --username, --session.',
      'CONFLICTING_SELECTORS',
    );
  }

  // 2. Zero sessions → hard exit 2.
  if (sessions.length === 0) {
    const err = new CliError(
      'No active sandbox sessions. Run: hookmyapp sandbox start',
      'NO_ACTIVE_SESSIONS',
    );
    err.exitCode = 2;
    throw err;
  }

  // 3. Flag-driven path.
  if (phoneFlag !== undefined) {
    const needle = phoneFlag.replace(/^\+/, '');
    const match = sessions.find(
      (s) => s.type === 'whatsapp' && s.whatsappPhone.replace(/^\+/, '') === needle,
    );
    if (!match) return throwMismatch(`--phone=${phoneFlag}`, sessions);
    return match;
  }

  if (usernameFlag !== undefined) {
    const needle = usernameFlag.replace(/^@/, '');
    const igSessions = sessions.filter((s) => s.type === 'instagram');
    const match = igSessions.find(
      (s) =>
        s.type === 'instagram' &&
        s.instagramSenderUsername !== null &&
        s.instagramSenderUsername === needle,
    );
    if (!match) {
      const allUsernamesNull =
        igSessions.length > 0 &&
        igSessions.every(
          (s) => s.type === 'instagram' && s.instagramSenderUsername === null,
        );
      if (allUsernamesNull) {
        const err = new CliError(
          'Instagram session has no username yet (still resolving from Meta). ' +
            'Use --session <ssn_X> to select by id. Run: hookmyapp sandbox status to list.',
          'SESSION_MISMATCH',
        );
        err.exitCode = 2;
        throw err;
      }
      return throwMismatch(`--username=${usernameFlag}`, sessions);
    }
    return match;
  }

  if (sessionFlag !== undefined) {
    const match = sessions.find((s) => s.id === sessionFlag);
    if (!match) return throwMismatch(`--session=${sessionFlag}`, sessions);
    return match;
  }

  // 4. No flag, single session → auto-pick (unless alwaysShowPicker).
  if (sessions.length === 1 && !alwaysShowPicker) {
    return sessions[0];
  }

  // 5. Multiple sessions OR alwaysShowPicker, with no flag.
  if (!isHuman) {
    const err = new CliError(
      'Multiple active sessions. Disambiguate with --phone, --username, or --session ' +
        '(required in --json / non-TTY mode).',
      'SESSION_MISMATCH',
    );
    err.exitCode = 2;
    throw err;
  }

  // 6. Interactive select.
  return select<SandboxSession>({
    message: 'Select a sandbox session',
    choices: sessions.map((s) => ({
      name: sessionLabel(s),
      value: s,
    })),
  });
}

function throwMismatch(needle: string, sessions: SandboxSession[]): never {
  const available = sessions.map(sessionIdentifier).join(', ');
  const err = new CliError(
    `No active session matches ${needle}. Available: ${available}. ` +
      `Run: hookmyapp sandbox status`,
    'SESSION_MISMATCH',
  );
  err.exitCode = 2;
  throw err;
}
