# CLI channels-Instagram + sandbox picker/logs retrofit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship full Instagram support across every `hookmyapp channels` subcommand, and retrofit `hookmyapp sandbox` subcommands to the same shape-detected positional picker convention + table-by-default logs UX, so both surfaces present one unified UX to customers and AI agents.

**Architecture:** Two-phase plan executed sequentially against the existing CLI codebase. Phase A retrofits sandbox first because (1) it establishes the shared `parseIdentifier()` helper that channels reuses, (2) it ships independently of the backend channels STI worktree status, and (3) it lets the channels-IG phase inherit a tested picker convention rather than introducing one mid-milestone. Phase B adds boundary parsers (`parseChannelListItem` / `parseChannelDetail`) that mirror the SandboxSession parser pattern, deletes the `ApiChannel` escape hatch, and adds an IG branch to every channels subcommand (connect chooser + login wizard, disconnect/enable/disable/env/token/health/webhook show+set, listen, logs list with new `--follow` + `--json`). Coexistence post-connect polling rewrite handles the "one OAuth → two channels" case deterministically.

**Tech Stack:** Node.js (ESM, NodeNext), TypeScript, Commander v14, `@inquirer/prompts`, picocolors, vitest. CLI binary: `@gethookmyapp/cli` 0.12.2 → 0.13.0.

**Spec reference:** `docs/superpowers/specs/2026-05-26-cli-channels-instagram-design.md` (committed at `468f196`). Decisions D1–D10 map to phases as follows:
- D3, D9, D10 → Phase A (sandbox picker + logs UX)
- D1, D2, D4, D5, D6, D7, D8 → Phase B (channels IG)

**Release strategy:** Single PR merged to `feat/instagram-sandbox` worktree, bumped to **0.13.0**. If the backend `multi-channel-instagram` worktree has not merged to `main` by Phase B start, Phase A ships standalone as `0.12.3` and Phase B follows as `0.13.0` once backend is ready. Either way, Phase A always lands first.

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `src/lib/parseIdentifier.ts` | Shared shape-detected identifier parser. Input: any string. Output: discriminated union `{ kind: 'phone' \| 'username' \| 'sessionId' \| 'channelId', value: string }` or throws `ValidationError` with a sharp suggestion. Phase A foundation; Phase B reuses for `resolveChannel`. |
| `src/lib/__tests__/parseIdentifier.test.ts` | Unit tests for every shape branch + every invalid-shape error message. |
| `src/api/channel.ts` | `parseChannelListItem(dto)` + `parseChannelDetail(dto)` boundary parsers. Exports `Channel = WhatsAppChannel \| InstagramChannel \| MessengerChannel` discriminated union (mirror frontend `frontend/src/types/channel.ts`) and `ChannelDetail` extending it with backend detail-only fields. Throws `UnexpectedError` with code `MALFORMED_CHANNEL` on shape violation of frozen fields; tolerates unknown extras. |
| `src/api/__tests__/channel.test.ts` | Parser tests: valid WA list-item, valid IG list-item, valid Messenger list-item, valid detail (each type), malformed (each invariant). |
| `src/commands/sandbox/__tests__/logs-default-format.test.ts` | Asserts the new table-by-default logs format per D9 (one-line summary: timestamp · sender · forward target · status · latency · preview). |
| `src/commands/channels-logs/__tests__/follow-mode.test.ts` | Asserts `channels logs list --follow` initiates an SSE stream and emits the same DTO shape as one-shot mode. |
| `src/commands/channels-logs/__tests__/json-mode.test.ts` | Asserts `channels logs list --json` emits JSONL output (one DTO per line). |

### Modified files

| Path | Why |
|---|---|
| `src/commands/sandbox/picker.ts` | Add `identifierArg` (positional shape-detected) as a fourth selector, route through `parseIdentifier`; keep existing `phoneFlag` / `usernameFlag` / `sessionFlag` as the typed fallback (D3). |
| `src/commands/sandbox/index.ts` | Add `[identifier]` positional argument to `stop`, `env`, `send`, `logs`, `listen`, `webhook show/set/clear` action signatures; pass through to picker. |
| `src/commands/sandbox/webhook.ts` | Rename deprecated `[phone]` positional to `[identifier]`; route via `parseIdentifier` instead of phone-only resolver (D3 retrofit). |
| `src/commands/sandbox/logs.ts` | Add `printSummaryDelivery(d)` for table-by-default; route `--verbose` to existing `printVerboseDelivery`; default switches from verbose → summary (D9). |
| `src/commands/sandbox-listen/picker.ts` | Add `identifierArg` to PickSessionArgs; delegate to the unified sandbox picker. |
| `src/commands/sandbox-listen/index.ts` | Action signature accepts `[identifier]` positional; pass to picker. |
| `src/commands/channels.ts` | Delete `ApiChannel` interface; replace with `Channel` / `ChannelDetail` imports from `src/api/channel.ts`. Rewrite `resolveChannel` to use `parseIdentifier` + `parseChannelListItem`. Add IG-branch logic where WA-specific fields are read. Replace `channelsConnect` action with type-aware version (D2): bare prompts in TTY, explicit `whatsapp` / `instagram` runs directly. Rewrite `runChannelsConnect` post-OAuth polling per D2 acceptance criteria (snapshot before, 4s stability gate, 5min timeout, report ALL new channels by type). |
| `src/auth/login.ts` | `--next channels` becomes channel-type-aware: prompts via `@inquirer/select` in TTY; exits 2 via D6 in non-TTY (no new flag needed). |
| `src/commands/channels-listen/index.ts` | Replace `ApiChannel` consumption with parsed `Channel`. IG branch: same tunnel mechanism, render uses `senderDisplay` from deliveries DTO (passthrough per D8). |
| `src/commands/channels-listen/picker.ts` | Add `identifierArg` for shape-detected positional; delegate identifier validation to `parseIdentifier`. |
| `src/commands/channels-logs/index.ts` | Add `--follow` / `-f` (SSE live tail) and `--json` (JSONL) flags to `logs list`. Both compose with existing `--limit` / `--since` / `--until` / `--cursor` / `--all`. New flags share implementation with `sandbox logs --follow` / `--json`. |
| `src/commands/channels-logs/render.ts` | IG-aware row render — narrow on `channel.type`, render `senderDisplay` verbatim. Add `printSummaryRow` for the unified table-by-default format (D9); existing detailed render becomes `--verbose`-only output. |
| `src/commands/channels-logs/api.ts` | Add `streamDeliveries(channelPublicId, ...)` SSE iterator; mirrors `sandbox logs` SSE wiring. |
| `src/commands/env.ts` | No code change required (channel-type-agnostic per D5). New acceptance test validates an IG channel returns the `INSTAGRAM_*` env key set. |
| `src/commands/token.ts` | Update help text to reflect IG support; no logic change (backend `/meta/channels/:id/token` already type-aware). |
| `src/commands/health.ts` | Update help text to reflect IG support; no logic change (backend `/meta/channels/:id/refresh` already type-aware). |
| `src/commands/webhook.ts` | Update help text to reflect IG support; no logic change beyond consuming parsed `Channel`. |
| `package.json` | Bump `version` 0.12.2 → 0.13.0. |
| `CHANGELOG.md` | Add 0.13.0 entry describing both phases. |

### Removed files

None. All changes are additive or in-place modifications.

---

## Phase A — Sandbox retrofit (D3 + D9 + D10)

### Task A1: Shared `parseIdentifier` helper

**Files:**
- Create: `src/lib/parseIdentifier.ts`
- Test: `src/lib/__tests__/parseIdentifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/__tests__/parseIdentifier.test.ts
import { describe, it, expect } from 'vitest';
import { parseIdentifier } from '../parseIdentifier.js';
import { ValidationError } from '../../output/error.js';

describe('parseIdentifier — shape detection', () => {
  it('+E164 phone → { kind: "phone", value: digits-only }', () => {
    expect(parseIdentifier('+972545434384')).toEqual({ kind: 'phone', value: '972545434384' });
    expect(parseIdentifier('+15551234567')).toEqual({ kind: 'phone', value: '15551234567' });
  });

  it('@handle username → { kind: "username", value: handle-without-@ }', () => {
    expect(parseIdentifier('@ordvir')).toEqual({ kind: 'username', value: 'ordvir' });
    expect(parseIdentifier('@hookmyappsandboxstaging')).toEqual({
      kind: 'username',
      value: 'hookmyappsandboxstaging',
    });
  });

  it('ssn_XXXXXXXX → { kind: "sessionId", value: full publicId }', () => {
    expect(parseIdentifier('ssn_hwj1LX3J')).toEqual({ kind: 'sessionId', value: 'ssn_hwj1LX3J' });
  });

  it('ch_XXXXXXXX → { kind: "channelId", value: full publicId }', () => {
    expect(parseIdentifier('ch_POWomFvq')).toEqual({ kind: 'channelId', value: 'ch_POWomFvq' });
  });

  it('bare digits without + → ValidationError with phone suggestion', () => {
    expect(() => parseIdentifier('972545434384')).toThrow(ValidationError);
    expect(() => parseIdentifier('972545434384')).toThrow(/Did you mean \+972545434384/);
  });

  it('bare letters without @ → ValidationError with username suggestion', () => {
    expect(() => parseIdentifier('ordvir')).toThrow(ValidationError);
    expect(() => parseIdentifier('ordvir')).toThrow(/Did you mean @ordvir/);
  });

  it('empty string → ValidationError', () => {
    expect(() => parseIdentifier('')).toThrow(ValidationError);
  });

  it('garbage like "!!!" → ValidationError listing all recognized shapes', () => {
    expect(() => parseIdentifier('!!!')).toThrow(/not a recognized identifier shape/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ordvir/COD/cli/.worktrees/feat-instagram-sandbox && npx vitest run src/lib/__tests__/parseIdentifier.test.ts
```

Expected: FAIL — `parseIdentifier` does not exist.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/parseIdentifier.ts
import { ValidationError } from '../output/error.js';

export type IdentifierKind = 'phone' | 'username' | 'sessionId' | 'channelId';

export interface ParsedIdentifier {
  kind: IdentifierKind;
  /**
   * Normalized value — for `phone` this is digits-only (no leading +);
   * for `username` this is the handle without leading @; for `sessionId`
   * and `channelId` this is the full publicId including prefix.
   */
  value: string;
}

const PHONE_RE = /^\+\d{7,15}$/;
const USERNAME_RE = /^@[A-Za-z0-9._]{1,32}$/;
const SESSION_ID_RE = /^ssn_[A-Za-z0-9]{8}$/;
const CHANNEL_ID_RE = /^ch_[A-Za-z0-9]{8}$/;
const BARE_DIGITS_RE = /^\d{7,15}$/;
const BARE_LETTERS_RE = /^[A-Za-z0-9._]{2,32}$/;

/**
 * Shape-detect an identifier supplied as a CLI positional argument.
 *
 * Recognized shapes (D3 of the channels-IG spec):
 *   +E164          → phone (WA)
 *   @handle        → username (IG)
 *   ssn_XXXXXXXX   → sandbox session publicId
 *   ch_XXXXXXXX    → channel publicId
 *
 * Bare digits / bare letters trigger sharp suggestions; everything else
 * throws ValidationError with the full recognized-shape list.
 */
export function parseIdentifier(raw: string): ParsedIdentifier {
  if (!raw || raw.length === 0) {
    throw new ValidationError(
      'Identifier is required. Provide +phone, @username, ssn_XXXXXXXX, or ch_XXXXXXXX.',
      'IDENTIFIER_REQUIRED',
    );
  }
  if (PHONE_RE.test(raw)) {
    return { kind: 'phone', value: raw.slice(1) };
  }
  if (USERNAME_RE.test(raw)) {
    return { kind: 'username', value: raw.slice(1) };
  }
  if (SESSION_ID_RE.test(raw)) {
    return { kind: 'sessionId', value: raw };
  }
  if (CHANNEL_ID_RE.test(raw)) {
    return { kind: 'channelId', value: raw };
  }
  if (BARE_DIGITS_RE.test(raw)) {
    throw new ValidationError(
      `"${raw}" is not a recognized identifier shape. Did you mean +${raw} (phone)?`,
      'IDENTIFIER_UNRECOGNIZED_SHAPE',
    );
  }
  if (BARE_LETTERS_RE.test(raw)) {
    throw new ValidationError(
      `"${raw}" is not a recognized identifier shape. Did you mean @${raw} (Instagram handle)?`,
      'IDENTIFIER_UNRECOGNIZED_SHAPE',
    );
  }
  throw new ValidationError(
    `"${raw}" is not a recognized identifier shape. Use one of: +<phone>, @<username>, ssn_XXXXXXXX, ch_XXXXXXXX.`,
    'IDENTIFIER_UNRECOGNIZED_SHAPE',
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/lib/__tests__/parseIdentifier.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/parseIdentifier.ts src/lib/__tests__/parseIdentifier.test.ts
git commit -m "feat(lib): shape-detected identifier parser for sandbox + channels pickers"
```

---

### Task A2: Wire `parseIdentifier` into sandbox picker (positional arg)

**Files:**
- Modify: `src/commands/sandbox/picker.ts`
- Test: `src/commands/sandbox/__tests__/picker.test.ts` (extend existing)

- [ ] **Step 1: Write failing tests for the new positional path**

Append to `src/commands/sandbox/__tests__/picker.test.ts`:

```typescript
describe('pickSession — identifierArg positional (D3)', () => {
  const wa: SandboxSession = {
    id: 'ssn_WA000001',
    type: 'whatsapp',
    whatsappPhone: '15551234567',
    whatsappPhoneNumberId: '111',
    sandboxPhoneNumberId: '111',
    whatsappApiVersion: 'v24.0',
    accessToken: 'a',
    hmacSecret: 'h',
    status: 'active',
    origin: 'manual',
  };
  const ig: SandboxSession = {
    id: 'ssn_IG000001',
    type: 'instagram',
    instagramSenderId: '111',
    instagramAccountId: '111',
    instagramSenderUsername: 'ordvir',
    accessToken: 'a',
    hmacSecret: 'h',
    status: 'active',
    origin: 'demo_handoff',
  };

  it('+phone positional resolves to WA session', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: '+15551234567',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_WA000001');
  });

  it('@handle positional resolves to IG session', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: '@ordvir',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_IG000001');
  });

  it('ssn_X positional resolves to exact session by id', async () => {
    const result = await pickSession({
      sessions: [wa, ig],
      identifierArg: 'ssn_IG000001',
      isHuman: false,
    });
    expect(result.id).toBe('ssn_IG000001');
  });

  it('ch_X positional → ValidationError (wrong family — channel id used on sandbox)', async () => {
    await expect(
      pickSession({
        sessions: [wa, ig],
        identifierArg: 'ch_abcdefgh',
        isHuman: false,
      }),
    ).rejects.toThrow(/channel publicId.*sandbox commands take ssn_X/);
  });

  it('positional + flag → CONFLICTING_SELECTORS', async () => {
    await expect(
      pickSession({
        sessions: [wa],
        identifierArg: '+15551234567',
        phoneFlag: '+15551234567',
        isHuman: false,
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });

  it('bare digits positional → sharp suggestion', async () => {
    await expect(
      pickSession({
        sessions: [wa],
        identifierArg: '15551234567',
        isHuman: false,
      }),
    ).rejects.toThrow(/Did you mean \+15551234567/);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
npx vitest run src/commands/sandbox/__tests__/picker.test.ts -t "identifierArg positional"
```

Expected: FAIL — `identifierArg` not in `PickSessionArgs`.

- [ ] **Step 3: Update the picker to accept `identifierArg`**

In `src/commands/sandbox/picker.ts`, extend `PickSessionArgs` and add the positional branch:

```typescript
// Add to imports at top of file:
import { parseIdentifier } from '../../lib/parseIdentifier.js';

// Extend PickSessionArgs:
export interface PickSessionArgs {
  sessions: SandboxSession[];
  /** Positional shape-detected identifier (D3). Mutually exclusive with the three flag fields. */
  identifierArg?: string;
  phoneFlag?: string;
  usernameFlag?: string;
  sessionFlag?: string;
  isHuman: boolean;
  alwaysShowPicker?: boolean;
}

// In pickSession, expand the conflict check (Step 1 of the existing function):
const flagsSet = [identifierArg, phoneFlag, usernameFlag, sessionFlag].filter(
  (f) => f !== undefined,
).length;
if (flagsSet > 1) {
  throw new ValidationError(
    'Conflicting selectors. Provide at most one of [positional identifier], --phone, --username, --session.',
    'CONFLICTING_SELECTORS',
  );
}

// Add a new branch BEFORE the existing phoneFlag branch (step 3):
if (identifierArg !== undefined) {
  const parsed = parseIdentifier(identifierArg);
  switch (parsed.kind) {
    case 'phone': {
      const match = sessions.find(
        (s) => s.type === 'whatsapp' && s.whatsappPhone.replace(/^\+/, '') === parsed.value,
      );
      if (!match) return throwMismatch(`+${parsed.value}`, sessions);
      return match;
    }
    case 'username': {
      const match = sessions.find(
        (s) =>
          s.type === 'instagram' &&
          s.instagramSenderUsername !== null &&
          s.instagramSenderUsername === parsed.value,
      );
      if (!match) return throwMismatch(`@${parsed.value}`, sessions);
      return match;
    }
    case 'sessionId': {
      const match = sessions.find((s) => s.id === parsed.value);
      if (!match) return throwMismatch(parsed.value, sessions);
      return match;
    }
    case 'channelId': {
      throw new ValidationError(
        `"${identifierArg}" is a channel publicId; sandbox commands take ssn_X. Did you mean a sandbox session?`,
        'WRONG_IDENTIFIER_FAMILY',
      );
    }
  }
}
```

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
npx vitest run src/commands/sandbox/__tests__/picker.test.ts
```

Expected: PASS — all picker tests, including the new positional ones.

- [ ] **Step 5: Run the full sandbox test suite to confirm no regressions**

```bash
npx vitest run src/commands/sandbox/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/sandbox/picker.ts src/commands/sandbox/__tests__/picker.test.ts
git commit -m "feat(sandbox/picker): accept positional shape-detected identifier via parseIdentifier"
```

---

### Task A3: Add `[identifier]` positional to sandbox `stop`, `env`, `send`, `logs`, `listen`

**Files:**
- Modify: `src/commands/sandbox/index.ts`

- [ ] **Step 1: Add positional argument to the 5 subcommand definitions**

Locate each of these blocks in `src/commands/sandbox/index.ts` and add `.argument('[identifier]', '...')` before the existing `.option('--phone ...')` line. Also extend the action signature.

For `sandboxStop` — **preserve the existing `-y, --yes` flag** (skips confirmation in CI / scripted deletion flows). The new positional is purely additive:

```typescript
const sandboxStop = sandbox
  .command('stop')
  .description('Delete a sandbox session')
  .argument(
    '[identifier]',
    'Positional shape-detected: +phone | @username | ssn_XXXXXXXX',
  )
  .option('--phone <e164>', 'Select WhatsApp session by phone')
  .option('--username <handle>', 'Select Instagram session by @handle')
  .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
  .option('-y, --yes', 'Skip confirmation')
  .option('--json', 'Machine-readable output')
  .action(
    async (
      identifier: string | undefined,
      opts: {
        phone?: string;
        username?: string;
        session?: string;
        yes?: boolean;
        json?: boolean;
      },
    ) => {
      await runSandboxStop({
        ...opts,
        identifierArg: identifier,
        json: !!(opts.json || program.opts().json),
      });
    },
  );
```

Repeat the same change shape for `sandboxEnv`, `sandboxSend`, `sandboxLogs`, and the sandbox-listen registration (which lives in `src/commands/sandbox-listen/index.ts`).

For `sandboxEnv` the action signature change is:

```typescript
.action(async (
  identifier: string | undefined,
  opts: { ... existing opts ... },
) => {
  await runSandboxEnv({
    ...opts,
    identifierArg: identifier,
    json: !!(opts.json || program.opts().json),
  });
});
```

Same shape for `send`, `logs`. The runtime helpers (`runSandboxStop`, `runSandboxEnv`, etc.) all accept `identifierArg` because their picker call passes it through.

- [ ] **Step 2: Update each runtime helper to pass `identifierArg` to the picker**

Each file (`src/commands/sandbox/stop.ts`, `env.ts`, `send.ts`, `logs.ts`) has a `pickSession({...})` call. Add `identifierArg: opts.identifierArg` to the args object. Example for `stop.ts`:

```typescript
// existing call:
const session = await pickSession({
  sessions,
  phoneFlag: opts.phone,
  usernameFlag: opts.username,
  sessionFlag: opts.session,
  isHuman,
});

// becomes:
const session = await pickSession({
  sessions,
  identifierArg: opts.identifierArg,
  phoneFlag: opts.phone,
  usernameFlag: opts.username,
  sessionFlag: opts.session,
  isHuman,
});
```

Also extend the opts interface in each file to include `identifierArg?: string;`.

- [ ] **Step 3: Write an end-to-end test for one subcommand using positional**

In `src/commands/sandbox/__tests__/send-positional.test.ts` (new file):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxSend } from '../send.js';

const ig = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '1907',
  instagramAccountId: '1784',
  instagramSenderUsername: 'ordvir',
  accessToken: 'tok',
  hmacSecret: 'hmac',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxSend — positional identifier (D3)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('positional @ordvir narrows to IG session', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])           // sessions list
      .mockResolvedValueOnce({ ok: true });  // send response
    await runSandboxSend({
      identifierArg: '@ordvir',
      message: 'hi',
      json: false,
    });
    expect(vi.mocked(apiClient).mock.calls[1][0]).toContain('1784/messages');
  });
});
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/commands/sandbox/__tests__/send-positional.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full vitest suite — confirm no regressions across the workspace**

```bash
npx vitest run
```

Expected: PASS (all 625+ tests; this task adds ~1 test, picker tests cover the rest).

- [ ] **Step 6: Commit**

```bash
git add src/commands/sandbox/index.ts src/commands/sandbox/stop.ts src/commands/sandbox/env.ts src/commands/sandbox/send.ts src/commands/sandbox/logs.ts src/commands/sandbox/__tests__/send-positional.test.ts
git commit -m "feat(sandbox): accept positional [identifier] on stop/env/send/logs"
```

---

### Task A4: Add `[identifier]` positional to sandbox `listen`

**Files:**
- Modify: `src/commands/sandbox-listen/index.ts`, `src/commands/sandbox-listen/picker.ts`

- [ ] **Step 1: Update sandbox-listen registration in `src/commands/sandbox-listen/index.ts`**

Find the `.command('listen')` registration (the function that wires the subcommand to Commander). Add `.argument('[identifier]', ...)` and extend the action signature:

```typescript
sandbox
  .command('listen')
  .description('Tunnel sandbox webhooks to localhost')
  .argument(
    '[identifier]',
    'Positional shape-detected: +phone | @username | ssn_XXXXXXXX',
  )
  .option('--phone <e164>', 'Select WhatsApp session by phone')
  .option('--username <handle>', 'Select Instagram session by @handle')
  .option('--session <ssn_X>', 'Select any session by id')
  .option('--json', 'Machine-readable output')
  .action(async (identifier: string | undefined, opts: {
    phone?: string; username?: string; session?: string; json?: boolean;
  }) => {
    await runSandboxListen({
      ...opts,
      identifierArg: identifier,
      json: !!(opts.json || program.opts().json),
    });
  });
```

- [ ] **Step 2: Update the listen picker to accept `identifierArg`**

In `src/commands/sandbox-listen/picker.ts`, extend `PickSessionArgs`:

```typescript
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
```

- [ ] **Step 3: Pass `identifierArg` through in the listen runtime**

In `runSandboxListen` (inside `src/commands/sandbox-listen/index.ts`), extend the opts type to include `identifierArg?: string` and pass it through to `pickSession({...})`.

- [ ] **Step 4: Write a regression test**

Append to `src/commands/__tests__/sandbox-listen-banner.test.ts` (or create `sandbox-listen-positional.test.ts`):

```typescript
describe('sandbox listen — positional identifier (D3)', () => {
  it('passes identifierArg through to picker', async () => {
    // The test wires runSandboxListen up to the same mock client + asserts
    // the picker selected the correct session by identifier. Mirror the
    // pattern in send-positional.test.ts.
  });
});
```

- [ ] **Step 5: Run all sandbox-listen tests**

```bash
npx vitest run src/commands/__tests__/sandbox-listen-banner.test.ts src/commands/sandbox-listen/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/sandbox-listen/index.ts src/commands/sandbox-listen/picker.ts src/commands/__tests__/
git commit -m "feat(sandbox/listen): accept positional [identifier]"
```

---

### Task A5: Repurpose `[phone]` positional on `sandbox webhook show/set/clear` → `[identifier]`

**Files:**
- Modify: `src/commands/sandbox/index.ts`, `src/commands/sandbox/webhook.ts`

- [ ] **Step 1: Update Commander argument definitions**

In `src/commands/sandbox/index.ts` for each of `webhookShow`, `webhookSet`, `webhookClear`:

```typescript
.argument(
  '[identifier]',
  'Positional shape-detected: +phone | @username | ssn_XXXXXXXX',
)
```

(Replaces the existing `.argument('[phone]', '[deprecated] ...')` line.)

Update the action handler signature: rename `positionalPhone` → `identifier`, route to picker through `identifierArg`.

- [ ] **Step 2: Update `runSandboxWebhookShow/Set/Clear` to use `identifierArg`**

In `src/commands/sandbox/webhook.ts`, replace the existing `resolvePhoneFromPositional` helper with a pass-through to the picker. The picker handles shape detection via `parseIdentifier`; the per-command resolver doesn't need its own.

```typescript
// Delete resolvePhoneFromPositional and its call sites.
// Update the BaseOpts interface:
interface BaseOpts {
  identifierArg?: string;
  phone?: string;
  username?: string;
  session?: string;
  json?: boolean;
}

// Update pickForWebhook:
async function pickForWebhook(opts: BaseOpts, alwaysShowPicker: boolean) {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);
  const isHuman = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    identifierArg: opts.identifierArg,
    phoneFlag: opts.phone,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman,
    alwaysShowPicker,
  });
  return { workspaceId, session };
}
```

- [ ] **Step 3: Update the existing webhook test to use positional identifier**

In `src/commands/sandbox/__tests__/webhook.test.ts`, replace the test `"WA + no custom webhook → mode:cli ..."` selector from `{ session: 'ssn_WA000001' }` to `{ identifierArg: '+15551234567' }`. Confirms positional works for webhook commands.

- [ ] **Step 4: Add a new test for conflicting positional + flag**

```typescript
it('throws CONFLICTING_SELECTORS when positional + --phone are both provided', async () => {
  vi.mocked(apiClient).mockResolvedValueOnce([wa]);
  await expect(
    runSandboxWebhookSet({
      identifierArg: '+15551234567',
      phone: '+15551234567',
      url: 'https://my.example/hook',
    }),
  ).rejects.toThrow(/Conflicting selectors/);
});
```

- [ ] **Step 5: Run the webhook test suite**

```bash
npx vitest run src/commands/sandbox/__tests__/webhook.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/sandbox/index.ts src/commands/sandbox/webhook.ts src/commands/sandbox/__tests__/webhook.test.ts
git commit -m "refactor(sandbox/webhook): repurpose [phone] positional to [identifier] (D3)"
```

---

### Task A6: Sandbox logs — flip default to table-by-default (D9 / D10)

**Files:**
- Modify: `src/commands/sandbox/logs.ts`, `src/commands/sandbox/index.ts`
- Create: `src/commands/sandbox/__tests__/logs-default-format.test.ts`

- [ ] **Step 1: Write the failing test for the new default format**

```typescript
// src/commands/sandbox/__tests__/logs-default-format.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxLogs } from '../logs.js';

const ig = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '1907',
  instagramAccountId: '1784',
  instagramSenderUsername: 'ordvir',
  accessToken: 'tok',
  hmacSecret: 'hmac',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxLogs — default is table-by-default (D9)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('prints one-line summary per delivery (timestamp · sender · target · status · latency · preview)', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({
        deliveries: [
          { id: 'wph_001', receivedAt: '2026-05-26T14:30:01Z' },
          { id: 'wph_002', receivedAt: '2026-05-26T14:32:15Z' },
        ],
      })
      .mockResolvedValueOnce({
        id: 'wph_001',
        routingDecision: 'forward',
        inboundBody: '{"text":"Hello from cli"}',
        fromPhone: null,
        senderDisplay: '@ordvir',
        senderId: '1907',
        receivedAt: '2026-05-26T14:30:01Z',
        humanStatus: 'delivered',
        humanStatusCopy: 'Delivered to your webhook',
        attempts: [
          {
            id: 'a1', attemptNumber: 1,
            forwardUrl: 'https://n8n.example/webhook',
            forwardRequestBody: '',
            forwardStatus: 200,
            forwardDurationMs: 150,
            forwardResponseBody: null,
            outcome: 'success',
            attemptedAt: '2026-05-26T14:30:01.150Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'wph_002',
        routingDecision: 'forward',
        inboundBody: '{"text":"test image"}',
        fromPhone: null,
        senderDisplay: '@ordvir',
        senderId: '1907',
        receivedAt: '2026-05-26T14:32:15Z',
        humanStatus: 'failed',
        humanStatusCopy: 'Webhook timed out',
        attempts: [
          {
            id: 'a2', attemptNumber: 1,
            forwardUrl: 'https://n8n.example/webhook',
            forwardRequestBody: '',
            forwardStatus: null,
            forwardDurationMs: null,
            forwardResponseBody: null,
            outcome: 'timeout',
            attemptedAt: '2026-05-26T14:32:15.500Z',
          },
        ],
      });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxLogs({ identifierArg: '@ordvir', limit: 5, json: false });
    const combined =
      outSpy.mock.calls.map((c) => c[0]).join('') +
      logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Default = summary lines, NOT verbose dump.
    expect(combined).not.toMatch(/inboundBody:/);
    expect(combined).not.toMatch(/Forward attempt:/);
    // Each summary row contains: sender, target host, status code, latency.
    expect(combined).toContain('@ordvir');
    expect(combined).toContain('n8n.example');
    expect(combined).toContain('200');
    expect(combined).toContain('150ms');
    expect(combined).toContain('timeout');
    outSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('--verbose returns the pre-flip detailed format', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ deliveries: [{ id: 'wph_001', receivedAt: '...' }] })
      .mockResolvedValueOnce({
        id: 'wph_001',
        routingDecision: 'forward',
        inboundBody: '{"text":"Hello from cli"}',
        fromPhone: null,
        senderDisplay: '@ordvir',
        senderId: '1907',
        receivedAt: '2026-05-26T14:30:01Z',
        humanStatus: 'delivered',
        humanStatusCopy: 'Delivered',
        attempts: [{
          id: 'a1', attemptNumber: 1,
          forwardUrl: 'https://n8n.example/webhook',
          forwardRequestBody: '',
          forwardStatus: 200,
          forwardDurationMs: 150,
          forwardResponseBody: null,
          outcome: 'success',
          attemptedAt: '2026-05-26T14:30:01.150Z',
        }],
      });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runSandboxLogs({ identifierArg: '@ordvir', limit: 1, verbose: true, json: false });
    const combined =
      outSpy.mock.calls.map((c) => c[0]).join('') +
      logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // --verbose contains inbound body + forward attempt block.
    expect(combined).toMatch(/inbound/i);
    expect(combined).toMatch(/Hello from cli/);
    outSpy.mockRestore();
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/commands/sandbox/__tests__/logs-default-format.test.ts
```

Expected: FAIL (default is currently verbose; `--verbose` flag doesn't exist yet).

- [ ] **Step 3: Add `printSummaryDelivery` to `src/commands/sandbox/logs.ts`**

Add a new function alongside `printVerboseDelivery`:

```typescript
/**
 * D9: one-line summary per delivery (table-by-default). The columns are:
 *   <local-time>  <senderDisplay>  →  <target-host>  <status>  (<latency>ms)  "<preview>"
 *
 * The two questions a customer reading `sandbox logs` is answering are
 *   1. did the message reach my server?
 *   2. what did my server say back?
 *
 * Both are visible per row without scrolling. --verbose returns the
 * old verbose dump for the rare "I want to see EVERYTHING about ONE row"
 * case (kubectl get pods → kubectl describe pod X pattern).
 */
function printSummaryDelivery(d: DeliveryDetail): void {
  const time = new Date(d.receivedAt).toLocaleString();
  const sender = d.senderDisplay ?? d.senderId ?? '(unknown)';
  const lastAttempt = d.attempts[d.attempts.length - 1];
  const target = lastAttempt?.forwardUrl
    ? new URL(lastAttempt.forwardUrl).host
    : '(no forward URL set)';
  const status =
    lastAttempt === undefined
      ? '—'
      : lastAttempt.forwardStatus !== null
        ? `${lastAttempt.forwardStatus}`
        : lastAttempt.outcome; // 'timeout' | 'network_error' | 'success' (latter ⇒ status was set)
  const latency =
    lastAttempt?.forwardDurationMs !== null && lastAttempt?.forwardDurationMs !== undefined
      ? `${lastAttempt.forwardDurationMs}ms`
      : '';
  const preview = previewInbound(d.inboundBody);
  process.stdout.write(
    `${time}  ${sender}  →  ${target}  ${status}${latency ? ` (${latency})` : ''}  ${preview}\n`,
  );
}

function previewInbound(body: string | null): string {
  if (!body) return '(empty)';
  let text: string;
  try {
    const parsed = JSON.parse(body);
    // Common WA + IG message shapes carry a text body in `text` or `message.text`.
    text = (parsed?.text ?? parsed?.message?.text ?? body).toString();
  } catch {
    text = body;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 40) text = text.slice(0, 40) + '…';
  return `"${text}"`;
}
```

- [ ] **Step 4: Update the JSON-mode flag handling: add `--verbose` to the command def and route to the correct printer**

In `src/commands/sandbox/index.ts` `sandboxLogs` definition:

```typescript
.option('-v, --verbose', 'Full inbound body + forward attempt dump (default is one-line summary)')
```

In the action signature add `verbose?: boolean`; pass it through to `runSandboxLogs`.

In `src/commands/sandbox/logs.ts` `runSandboxLogs`:

```typescript
// where printVerboseDelivery(detail, session.type) currently runs:
if (opts.verbose) {
  printVerboseDelivery(detail, session.type);
} else {
  printSummaryDelivery(detail);
}
```

Also extend the `runSandboxLogs` opts interface to include `verbose?: boolean`.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/commands/sandbox/__tests__/logs-default-format.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full sandbox test suite**

```bash
npx vitest run src/commands/sandbox/
```

Expected: PASS (existing logs verbose tests still pass via `--verbose` flag in those tests; if any of them assert against the old default, update to add `verbose: true`).

- [ ] **Step 7: Commit**

```bash
git add src/commands/sandbox/logs.ts src/commands/sandbox/index.ts src/commands/sandbox/__tests__/logs-default-format.test.ts
git commit -m "feat(sandbox/logs): table-by-default, --verbose for the dump (D9)"
```

---

### Task A7: Phase A integration smoke + version bump preview

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full test + tsc + build pipeline**

```bash
npx tsc --noEmit && npx vitest run && npm run build
```

Expected: tsc clean, all tests pass, build emits `dist/cli.js`.

- [ ] **Step 2: Manual smoke from a real terminal**

```bash
node dist/cli.js sandbox send +972545434384 --message "phase A smoke"
node dist/cli.js sandbox logs --limit 3
node dist/cli.js sandbox logs --limit 3 --verbose
node dist/cli.js sandbox webhook show @ordvir
```

Expected:
- `send` succeeds (positional + works)
- `logs` (no --verbose): 3 one-line summaries
- `logs --verbose`: 3 detailed dumps
- `webhook show @ordvir`: prints the IG session's webhook URL

- [ ] **Step 3: Add Phase A CHANGELOG entry**

Append to `CHANGELOG.md` at the top of the unreleased section:

```markdown
## Phase A (sandbox retrofit, D3 + D9) — `0.13.0-pre`

### Added
- Positional shape-detected identifier on `sandbox stop/env/send/logs/listen/webhook show/set/clear` — `hookmyapp sandbox send +972545434384 --message "hi"` instead of `--phone +972545434384`. Existing `--phone` / `--username` / `--session` flags remain as a typed-fallback path.
- `sandbox logs --verbose` flag — full inbound body + forward attempt dump.
- `parseIdentifier()` shared helper at `src/lib/parseIdentifier.ts` for shape detection across sandbox and channels commands.

### Changed
- **`sandbox logs` default render flipped to table-by-default** (one-line summary per delivery: timestamp · sender · target · status · latency · preview). Use `--verbose` for the previous detailed format.
- The deprecated `[phone]` positional on `sandbox webhook show/set/clear` is repurposed to `[identifier]` — accepts `+phone`, `@username`, `ssn_XXXXXXXX`. The deprecation warning is removed; positional is now first-class.
```

- [ ] **Step 4: Commit Phase A close-out**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Phase A — sandbox positional picker + logs UX flip"
```

---

## Phase B — Channels Instagram support (D1, D2, D4, D5, D6, D7, D8)

### Task B1: `parseChannelListItem` + `parseChannelDetail` boundary parsers

**Files:**
- Create: `src/api/channel.ts`, `src/api/__tests__/channel.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/api/__tests__/channel.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseChannelListItem,
  parseChannelDetail,
  type Channel,
  type ChannelDetail,
} from '../channel.js';
import { UnexpectedError } from '../../output/error.js';

const baseValidWa = {
  id: 'ch_WAaaaaaa',
  type: 'whatsapp',
  workspaceId: 'ws_aaaaaaa',
  metaWabaId: '1179304900593762',
  metaResourceId: '1080996501762047',
  connectionType: 'cloud_api',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: 'https://my.example/hook',
  verifyToken: 'vt_xxx',
  wabaName: 'My WABA',
  displayPhoneNumber: '+15551234567',
  phoneNumberId: '1080996501762047',
  phoneVerifiedName: 'Test Co.',
  qualityRating: 'GREEN',
  qualityRatingCheckedAt: '2026-05-26T12:00:00Z',
};

const baseValidIg = {
  id: 'ch_IGaaaaaa',
  type: 'instagram',
  workspaceId: 'ws_aaaaaaa',
  metaWabaId: '',
  metaResourceId: '17841478719287768',
  connectionType: 'instagram_login',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: null,
  verifyToken: 'vt_yyy',
  instagramUsername: 'ordvir',
  instagramName: 'Or Dvir',
  instagramProfilePictureUrl: 'https://cdninstagram.com/...',
};

describe('parseChannelListItem', () => {
  it('parses a valid WhatsApp list-item', () => {
    const out: Channel = parseChannelListItem(baseValidWa);
    expect(out.type).toBe('whatsapp');
    if (out.type === 'whatsapp') {
      expect(out.wabaName).toBe('My WABA');
      expect(out.displayPhoneNumber).toBe('+15551234567');
    }
  });

  it('parses a valid Instagram list-item', () => {
    const out: Channel = parseChannelListItem(baseValidIg);
    expect(out.type).toBe('instagram');
    if (out.type === 'instagram') {
      expect(out.instagramUsername).toBe('ordvir');
    }
  });

  it('tolerates unknown extras on the wire (forward-compat)', () => {
    expect(() =>
      parseChannelListItem({ ...baseValidWa, newBackendField: 'whatever' }),
    ).not.toThrow();
  });

  it('throws UnexpectedError MALFORMED_CHANNEL when type is missing', () => {
    const { type: _t, ...broken } = baseValidWa;
    expect(() => parseChannelListItem(broken)).toThrow(UnexpectedError);
    expect(() => parseChannelListItem(broken)).toThrow(/MALFORMED_CHANNEL/);
  });

  it('throws when WA channel is missing required wabaName', () => {
    const { wabaName: _w, ...broken } = baseValidWa;
    expect(() => parseChannelListItem(broken)).toThrow(/wabaName/);
  });

  it('throws when type is "messenger" (forward-compat: union allows it)', () => {
    const messenger = {
      id: 'ch_MS000000',
      type: 'messenger',
      workspaceId: 'ws_aaaaaaa',
      metaWabaId: '',
      metaResourceId: '1234',
      connectionType: null,
      metaConnected: false,
      forwardingEnabled: false,
      webhookUrl: null,
      verifyToken: null,
    };
    expect(parseChannelListItem(messenger).type).toBe('messenger');
  });
});

describe('parseChannelDetail', () => {
  it('extends list-item with detail-only fields (accessToken, businessName, metaBusinessId)', () => {
    const detail: ChannelDetail = parseChannelDetail({
      ...baseValidWa,
      accessToken: 'EAAxxx...',
      businessName: 'Test Business',
      metaBusinessId: '100000000000000',
    });
    expect(detail.accessToken).toBe('EAAxxx...');
    expect(detail.businessName).toBe('Test Business');
    expect(detail.metaBusinessId).toBe('100000000000000');
  });

  it('list-item shape (without detail fields) parses with detail-only fields undefined', () => {
    const detail = parseChannelDetail(baseValidIg);
    expect(detail.accessToken).toBeUndefined();
    expect(detail.businessName).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/api/__tests__/channel.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the parsers**

```typescript
// src/api/channel.ts
import { UnexpectedError } from '../output/error.js';

interface ChannelBase {
  id: string;
  workspaceId: string;
  metaWabaId: string;
  metaResourceId: string;
  connectionType: string | null;
  metaConnected: boolean;
  forwardingEnabled: boolean;
  webhookUrl: string | null;
  verifyToken: string | null;
  hasActiveCliTunnel?: boolean;
  hostname?: string | null;
  lastHeartbeatAt?: string | null;
}

export interface WhatsAppChannel extends ChannelBase {
  type: 'whatsapp';
  wabaName: string | null;
  displayPhoneNumber: string | null;
  phoneNumberId: string | null;
  phoneVerifiedName: string | null;
  qualityRating: string | null;
  qualityRatingCheckedAt: string | null;
}

export interface InstagramChannel extends ChannelBase {
  type: 'instagram';
  instagramUsername: string | null;
  instagramName: string | null;
  instagramProfilePictureUrl: string | null;
}

export interface MessengerChannel extends ChannelBase {
  type: 'messenger';
}

export type Channel = WhatsAppChannel | InstagramChannel | MessengerChannel;

/** Detail-only fields returned by GET /meta/channels/:id (not on list endpoint). */
interface DetailExtras {
  accessToken?: string;
  businessName?: string;
  metaBusinessId?: string;
}

export type ChannelDetail = Channel & DetailExtras;

function malformed(id: string, reason: string): never {
  throw new UnexpectedError(
    `Backend returned malformed channel ${id}: ${reason}. ` +
      `Report at https://github.com/hookmyapp/cli/issues`,
    'MALFORMED_CHANNEL',
  );
}

function isStringOrNull(v: unknown): v is string | null {
  return typeof v === 'string' || v === null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function parseBase(d: Record<string, unknown>, id: string): ChannelBase {
  if (!isNonEmptyString(d.id)) malformed(id, 'id missing');
  if (!isNonEmptyString(d.workspaceId)) malformed(id, 'workspaceId missing');
  if (typeof d.metaWabaId !== 'string') malformed(id, 'metaWabaId must be a string');
  if (!isNonEmptyString(d.metaResourceId)) malformed(id, 'metaResourceId missing');
  if (typeof d.connectionType !== 'string' && d.connectionType !== null)
    malformed(id, 'connectionType must be string or null');
  if (typeof d.metaConnected !== 'boolean') malformed(id, 'metaConnected must be a boolean');
  if (typeof d.forwardingEnabled !== 'boolean')
    malformed(id, 'forwardingEnabled must be a boolean');
  if (!isStringOrNull(d.webhookUrl)) malformed(id, 'webhookUrl must be string or null');
  if (!isStringOrNull(d.verifyToken)) malformed(id, 'verifyToken must be string or null');
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    metaWabaId: d.metaWabaId,
    metaResourceId: d.metaResourceId,
    connectionType: d.connectionType,
    metaConnected: d.metaConnected,
    forwardingEnabled: d.forwardingEnabled,
    webhookUrl: d.webhookUrl,
    verifyToken: d.verifyToken,
    hasActiveCliTunnel: typeof d.hasActiveCliTunnel === 'boolean' ? d.hasActiveCliTunnel : undefined,
    hostname: isStringOrNull(d.hostname) ? d.hostname : undefined,
    lastHeartbeatAt: isStringOrNull(d.lastHeartbeatAt) ? d.lastHeartbeatAt : undefined,
  };
}

export function parseChannelListItem(dto: unknown): Channel {
  if (typeof dto !== 'object' || dto === null) {
    throw new UnexpectedError(
      `Backend returned malformed channel: expected an object, got ${typeof dto}.`,
      'MALFORMED_CHANNEL',
    );
  }
  const d = dto as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id : '<unknown>';
  const base = parseBase(d, id);
  if (!isNonEmptyString(d.type)) malformed(id, 'type missing');
  switch (d.type) {
    case 'whatsapp': {
      if (!isStringOrNull(d.wabaName)) malformed(id, 'WA channel: wabaName must be string or null');
      if (!isStringOrNull(d.displayPhoneNumber))
        malformed(id, 'WA channel: displayPhoneNumber must be string or null');
      if (!isStringOrNull(d.phoneNumberId))
        malformed(id, 'WA channel: phoneNumberId must be string or null');
      if (!isStringOrNull(d.phoneVerifiedName))
        malformed(id, 'WA channel: phoneVerifiedName must be string or null');
      if (!isStringOrNull(d.qualityRating))
        malformed(id, 'WA channel: qualityRating must be string or null');
      if (!isStringOrNull(d.qualityRatingCheckedAt))
        malformed(id, 'WA channel: qualityRatingCheckedAt must be string or null');
      return {
        ...base,
        type: 'whatsapp',
        wabaName: d.wabaName,
        displayPhoneNumber: d.displayPhoneNumber,
        phoneNumberId: d.phoneNumberId,
        phoneVerifiedName: d.phoneVerifiedName,
        qualityRating: d.qualityRating,
        qualityRatingCheckedAt: d.qualityRatingCheckedAt,
      };
    }
    case 'instagram': {
      if (!isStringOrNull(d.instagramUsername))
        malformed(id, 'IG channel: instagramUsername must be string or null');
      if (!isStringOrNull(d.instagramName))
        malformed(id, 'IG channel: instagramName must be string or null');
      if (!isStringOrNull(d.instagramProfilePictureUrl))
        malformed(id, 'IG channel: instagramProfilePictureUrl must be string or null');
      return {
        ...base,
        type: 'instagram',
        instagramUsername: d.instagramUsername,
        instagramName: d.instagramName,
        instagramProfilePictureUrl: d.instagramProfilePictureUrl,
      };
    }
    case 'messenger': {
      return { ...base, type: 'messenger' };
    }
    default:
      malformed(id, `unknown type "${d.type}"`);
  }
}

export function parseChannelDetail(dto: unknown): ChannelDetail {
  const base = parseChannelListItem(dto);
  if (typeof dto !== 'object' || dto === null) return base; // already threw above
  const d = dto as Record<string, unknown>;
  return {
    ...base,
    accessToken: typeof d.accessToken === 'string' ? d.accessToken : undefined,
    businessName: typeof d.businessName === 'string' ? d.businessName : undefined,
    metaBusinessId: typeof d.metaBusinessId === 'string' ? d.metaBusinessId : undefined,
  };
}

/** Parse an array response from GET /meta/channels (or anywhere that returns Channel[]). */
export function parseChannels(dtos: unknown[]): Channel[] {
  return dtos.map(parseChannelListItem);
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/api/__tests__/channel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/channel.ts src/api/__tests__/channel.test.ts
git commit -m "feat(api): boundary parsers parseChannelListItem + parseChannelDetail (D4)"
```

---

### Task B2: Delete `ApiChannel`, rewrite `resolveChannel` to use `parseIdentifier` + parsed `Channel`

**Files:**
- Modify: `src/commands/channels.ts`

- [ ] **Step 1: Write failing tests for the new resolver shape**

In `src/__tests__/channels-resolve.test.ts` (new file):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import { resolveChannel } from '../commands/channels.js';

const wa = {
  id: 'ch_WAaaaaaa', type: 'whatsapp', workspaceId: 'ws_TEST0001',
  metaWabaId: '1179', metaResourceId: '1080', connectionType: 'cloud_api',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  wabaName: 'My WABA', displayPhoneNumber: '+15551234567', phoneNumberId: '1080',
  phoneVerifiedName: 'Test', qualityRating: null, qualityRatingCheckedAt: null,
};
const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('resolveChannel — shape-detected positional', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('+phone narrows to WA channel by displayPhoneNumber', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const out = await resolveChannel('+15551234567');
    expect(out.id).toBe('ch_WAaaaaaa');
  });

  it('@handle narrows to IG channel by instagramUsername', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const out = await resolveChannel('@ordvir');
    expect(out.id).toBe('ch_IGaaaaaa');
  });

  it('ch_X exact match', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const out = await resolveChannel('ch_IGaaaaaa');
    expect(out.id).toBe('ch_IGaaaaaa');
  });

  it('ssn_X → ValidationError (wrong family)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    await expect(resolveChannel('ssn_abcdefgh')).rejects.toThrow(/sandbox session publicId.*channels commands take ch_X/);
  });

  it('no match → CliError with available identifiers listed', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    await expect(resolveChannel('@nobody')).rejects.toThrow(/No channel matches @nobody/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/__tests__/channels-resolve.test.ts
```

Expected: FAIL — resolver still uses old fuzzy logic.

- [ ] **Step 3: Rewrite `src/commands/channels.ts`**

Delete the `ApiChannel` interface, the `PUBLIC_ID_PATTERN`, the `NUMERIC_WABA_PATTERN` const, and the old `resolveChannel` body. Replace with imports from `src/api/channel.ts` and a `parseIdentifier`-based resolver:

```typescript
import { parseChannelListItem, parseChannelDetail, type Channel, type ChannelDetail } from '../api/channel.js';
import { parseIdentifier } from '../lib/parseIdentifier.js';
import { CliError, ValidationError } from '../output/error.js';

/**
 * Resolve a CLI channel reference (D3 — shape-detected positional) to a parsed
 * Channel. Accepted shapes:
 *   +E164          → WA channel by displayPhoneNumber
 *   @handle        → IG channel by instagramUsername
 *   ch_XXXXXXXX    → exact publicId match
 *
 * Mismatched-family shapes (ssn_X) throw ValidationError with a wrong-family
 * suggestion; unrecognized shapes propagate parseIdentifier's error.
 */
export async function resolveChannel(ref: string): Promise<Channel> {
  const { getDefaultWorkspaceId } = await import('./_helpers.js');
  const workspaceId = await getDefaultWorkspaceId();
  const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
  const channels = dtos.map(parseChannelListItem);
  const parsed = parseIdentifier(ref);
  switch (parsed.kind) {
    case 'phone': {
      const needle = parsed.value;
      const match = channels.find(
        (c): c is Channel & { type: 'whatsapp' } =>
          c.type === 'whatsapp' &&
          c.displayPhoneNumber !== null &&
          c.displayPhoneNumber.replace(/[^\d]/g, '') === needle,
      );
      if (match) return match;
      return throwNoMatch(`+${needle}`, channels);
    }
    case 'username': {
      const match = channels.find(
        (c): c is Channel & { type: 'instagram' } =>
          c.type === 'instagram' && c.instagramUsername === parsed.value,
      );
      if (match) return match;
      return throwNoMatch(`@${parsed.value}`, channels);
    }
    case 'channelId': {
      const match = channels.find((c) => c.id === parsed.value);
      if (match) return match;
      return throwNoMatch(parsed.value, channels);
    }
    case 'sessionId': {
      throw new ValidationError(
        `"${ref}" is a sandbox session publicId; channels commands take ch_X. Did you mean a channel?`,
        'WRONG_IDENTIFIER_FAMILY',
      );
    }
  }
}

function throwNoMatch(needle: string, channels: Channel[]): never {
  const available = channels
    .map((c) => {
      if (c.type === 'whatsapp') return c.displayPhoneNumber ?? c.id;
      if (c.type === 'instagram') return c.instagramUsername ? `@${c.instagramUsername}` : c.id;
      return c.id;
    })
    .join(', ');
  const err = new CliError(
    `No channel matches ${needle}. Available: ${available || '(none)'}. ` +
      `Run: hookmyapp channels list`,
    'CHANNEL_NOT_FOUND',
  );
  err.exitCode = 2;
  throw err;
}
```

Also delete the `pickDisplayFields` helper if it referenced `ApiChannel` only, OR update its parameter to `Channel`. Every call site that consumed `ApiChannel` now imports `Channel` from `src/api/channel.ts`.

- [ ] **Step 4: Update every call site that imported `ApiChannel`**

Run:

```bash
grep -rn "ApiChannel" src/ | grep -v test
```

For each match: replace `ApiChannel` import with `Channel` (or `ChannelDetail` for detail-fetching call sites). Touched files include `src/commands/channels.ts`, `src/commands/channels-listen/`, `src/commands/env.ts`, `src/commands/token.ts`, `src/commands/health.ts`, `src/commands/webhook.ts`.

For each `await apiClient('/meta/channels/${channel.id}')` call that uses detail fields (`accessToken`, `businessName`, `metaBusinessId`), wrap the response with `parseChannelDetail`. For each `await apiClient('/meta/channels')` array fetch, map with `parseChannelListItem`.

- [ ] **Step 5: Run the resolver test + the full vitest suite**

```bash
npx vitest run src/__tests__/channels-resolve.test.ts
npx vitest run
```

Expected: PASS.

- [ ] **Step 6: Run tsc**

```bash
npx tsc --noEmit
```

Expected: clean (all `ApiChannel` references removed, all detail-field reads go through `ChannelDetail`).

- [ ] **Step 7: Commit**

```bash
git add src/commands/channels.ts src/commands/channels-listen/ src/commands/env.ts src/commands/token.ts src/commands/health.ts src/commands/webhook.ts src/__tests__/channels-resolve.test.ts
git commit -m "refactor(channels): delete ApiChannel, route resolveChannel through parseIdentifier + boundary parsers (D3+D4)"
```

---

### Task B3: `channels list` IG-aware render

**Files:**
- Modify: `src/commands/channels.ts` (the `channelsList` action handler)

- [ ] **Step 1: Write a test that asserts IG rows render correctly**

In `src/__tests__/channels-list-render.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import { runChannelsList } from '../commands/channels.js'; // export this from channels.ts

const wa = { /* ...as before... */ };
const ig = { /* ...as before... */ };

describe('runChannelsList — IG rows are visible', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('JSON mode emits both WA and IG channels in the array', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelsList({ json: true });
    const payload = JSON.parse(outSpy.mock.calls[0][0] as string);
    expect(payload).toHaveLength(2);
    expect(payload.map((c: any) => c.type)).toEqual(expect.arrayContaining(['whatsapp', 'instagram']));
    outSpy.mockRestore();
  });

  it('human-table mode includes both an IG row with @handle and a WA row with +phone', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelsList({ json: false });
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('@ordvir');
    expect(combined).toContain('+15551234567');
    outSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/__tests__/channels-list-render.test.ts
```

Expected: FAIL — current `channelsList` uses WA-shaped column names; export of `runChannelsList` may not exist.

- [ ] **Step 3: Extract `runChannelsList` from the Commander action**

In `src/commands/channels.ts`, find the `channelsList = channels.command('list')...action(...)` block. Move the action body into a new exported function:

```typescript
export async function runChannelsList(opts: { json?: boolean }): Promise<void> {
  const workspaceId = await getDefaultWorkspaceId();
  const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
  const channels = dtos.map(parseChannelListItem);
  if (opts.json) {
    process.stdout.write(JSON.stringify(channels, null, 2) + '\n');
    return;
  }
  if (channels.length === 0) {
    console.log('No channels. Run: hookmyapp channels connect <whatsapp|instagram>');
    return;
  }
  // Rename loop var to `ch` so it doesn't shadow the imported color helper
  // `c` from src/output/color.js — calling `c.success('on')` would otherwise
  // type-error against Channel.
  const rows = channels.map((ch) => ({
    Type: ch.type === 'whatsapp' ? 'WhatsApp' : ch.type === 'instagram' ? 'Instagram' : 'Messenger',
    Identifier:
      ch.type === 'whatsapp'
        ? ch.displayPhoneNumber ?? ch.wabaName ?? ch.id
        : ch.type === 'instagram'
          ? ch.instagramUsername
            ? `@${ch.instagramUsername}`
            : ch.id
          : ch.id,
    'Channel ID': ch.id,
    Forwarding: ch.forwardingEnabled ? c.success('on') : c.dim('off'),
  }));
  process.stdout.write(renderTable(rows) + '\n');
}
// then in the Commander wiring:
channelsList.action(async (opts: { json?: boolean }) => {
  await runChannelsList({ ...opts, json: !!(opts.json || program.opts().json) });
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/__tests__/channels-list-render.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels.ts src/__tests__/channels-list-render.test.ts
git commit -m "feat(channels/list): IG-aware row render (@handle vs +phone)"
```

---

### Task B4: `channels show` IG-aware detail render

**Files:**
- Modify: `src/commands/channels.ts` (the `channelsShow` action)

- [ ] **Step 1: Update `channelsShow` action to consume `parseChannelDetail`**

Extract the action body into `runChannelsShow(ref: string, opts: { json?: boolean })`. Replace direct field access on the response with:

```typescript
const channel: ChannelDetail = parseChannelDetail(
  await apiClient(`/meta/channels/${(await resolveChannel(ref)).id}`),
);
```

Render per channel type:

```typescript
if (opts.json) {
  process.stdout.write(JSON.stringify(channel, null, 2) + '\n');
  return;
}
console.log(`Type: ${channel.type}`);
console.log(`ID: ${channel.id}`);
if (channel.type === 'whatsapp') {
  console.log(`WABA: ${channel.wabaName ?? '(unnamed)'}`);
  console.log(`Phone: ${channel.displayPhoneNumber ?? '(none)'}`);
  console.log(`Phone Number ID: ${channel.phoneNumberId ?? '(none)'}`);
  console.log(`Quality rating: ${channel.qualityRating ?? '(unknown)'}`);
} else if (channel.type === 'instagram') {
  console.log(`Instagram: @${channel.instagramUsername ?? '(no handle)'}`);
  console.log(`Display name: ${channel.instagramName ?? '(none)'}`);
}
console.log(`Forwarding: ${channel.forwardingEnabled ? 'on' : 'off'}`);
console.log(`Webhook URL: ${channel.webhookUrl ?? '(uses CLI tunnel)'}`);
if (channel.businessName) console.log(`Business: ${channel.businessName}`);
```

- [ ] **Step 2: Write tests for both types**

In `src/__tests__/channels-show.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import { runChannelsShow } from '../commands/channels.js';

const wa = {
  id: 'ch_WAaaaaaa', type: 'whatsapp', workspaceId: 'ws_TEST0001',
  metaWabaId: '1179', metaResourceId: '1080', connectionType: 'cloud_api',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  wabaName: 'My WABA', displayPhoneNumber: '+15551234567', phoneNumberId: '1080',
  phoneVerifiedName: 'Test', qualityRating: 'GREEN', qualityRatingCheckedAt: '2026-05-26T12:00:00Z',
};
const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: 'https://my.example/hook', verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or Dvir', instagramProfilePictureUrl: null,
};

describe('runChannelsShow — type-aware detail render', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('WA channel prints +phone + wabaName + quality rating', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])  // resolveChannel list fetch
      .mockResolvedValueOnce({ ...wa, accessToken: 'EAAxxx', businessName: 'Test Biz' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsShow('+15551234567', { json: false });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('+15551234567');
    expect(combined).toContain('My WABA');
    expect(combined).toContain('GREEN');
    expect(combined).toContain('Test Biz');
    expect(combined).not.toContain('Instagram');
    logSpy.mockRestore();
  });

  it('IG channel prints @handle + display name + webhook URL', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce(ig);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsShow('@ordvir', { json: false });
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('@ordvir');
    expect(combined).toContain('Or Dvir');
    expect(combined).toContain('https://my.example/hook');
    expect(combined).not.toContain('WABA');
    expect(combined).not.toContain('quality');
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run the test**

```bash
npx vitest run src/__tests__/channels-show.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/channels.ts src/__tests__/channels-show.test.ts
git commit -m "feat(channels/show): IG-aware detail render via parseChannelDetail"
```

---

### Task B5: `channels connect [type]` — type chooser + login wizard integration (D2 + D6)

**Files:**
- Modify: `src/commands/channels.ts`, `src/auth/login.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/channels-connect.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));
vi.mock('open', () => ({ default: vi.fn() }));

import { runChannelsConnect } from '../commands/channels.js';
import { select } from '@inquirer/prompts';
import { ValidationError } from '../output/error.js';

describe('runChannelsConnect — type chooser (D2)', () => {
  beforeEach(() => {
    vi.mocked(select).mockReset();
    process.stdout.isTTY = true;
  });

  it('explicit whatsapp → no prompt, POSTs to /meta/oauth/start', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])  // initial /meta/channels snapshot (BEFORE open)
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example/wa-oauth', codeChallenge: 'c' })
      .mockResolvedValueOnce([]); // first poll tick — empty (test only cares about routing)
    await runChannelsConnect({ type: 'whatsapp' }).catch(() => {}); // OK if it times out; we only assert routing
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    const startCall = vi.mocked(apiClient).mock.calls.find((c) => c[0] === '/meta/oauth/start');
    expect(startCall).toBeDefined();
  });

  it('explicit instagram → no prompt, POSTs to /instagram/oauth/start', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ redirectUrl: 'https://meta.example/ig-oauth' })
      .mockResolvedValueOnce([]);
    await runChannelsConnect({ type: 'instagram' }).catch(() => {});
    expect(vi.mocked(select)).not.toHaveBeenCalled();
    const startCall = vi.mocked(apiClient).mock.calls.find((c) => c[0] === '/instagram/oauth/start');
    expect(startCall).toBeDefined();
  });

  it('bare (no type) in TTY → prompts via @inquirer/select', async () => {
    vi.mocked(select).mockResolvedValueOnce('instagram');
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ redirectUrl: 'https://meta.example/ig-oauth' })
      .mockResolvedValueOnce([]);
    await runChannelsConnect({}).catch(() => {});
    expect(vi.mocked(select)).toHaveBeenCalled();
  });

  it('bare in non-TTY → ValidationError CONNECT_REQUIRES_TTY (D6)', async () => {
    process.stdout.isTTY = false;
    await expect(runChannelsConnect({})).rejects.toThrow(ValidationError);
    await expect(runChannelsConnect({})).rejects.toThrow(/CONNECT_REQUIRES_TTY|connect requires a browser/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/__tests__/channels-connect.test.ts
```

Expected: FAIL — no `runChannelsConnect` export with `{ type? }` opts.

- [ ] **Step 3: Refactor the existing `channels connect` action**

In `src/commands/channels.ts`:

```typescript
import { select } from '@inquirer/prompts';
// existing imports

interface ChannelsConnectOpts {
  type?: 'whatsapp' | 'instagram';
}

export async function runChannelsConnect(opts: ChannelsConnectOpts): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY);
  if (!isTty) {
    throw new ValidationError(
      'channels connect requires a TTY (browser launch + OAuth). ' +
        'In CI, call the backend API directly.',
      'CONNECT_REQUIRES_TTY',
    );
  }
  let type = opts.type;
  if (type === undefined) {
    type = await select<'whatsapp' | 'instagram'>({
      message: 'Which channel type?',
      choices: [
        { name: 'WhatsApp', value: 'whatsapp' },
        { name: 'Instagram', value: 'instagram' },
      ],
    });
  }

  const workspaceId = await getDefaultWorkspaceId();

  // 1. SNAPSHOT EXISTING CHANNEL IDS BEFORE OPENING THE BROWSER (D2).
  //    Doing this AFTER open() races a fast backend write — the "new"
  //    channel could be included in the snapshot and never reported.
  const initialDtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
  const existingIds = new Set(initialDtos.map(parseChannelListItem).map((c) => c.id));

  // 2. Route to the per-type OAuth start endpoint. WA and IG are
  //    distinct controllers; the request body is `OAuthStartDto` for
  //    both (only `redirectPath`, no `channelType`). Both responses
  //    return `{ redirectUrl }`. WA additionally returns
  //    `{ state, codeChallenge }` which the CLI does not consume.
  const startPath = type === 'whatsapp' ? '/meta/oauth/start' : '/instagram/oauth/start';
  const { redirectUrl } = (await apiClient(startPath, {
    method: 'POST',
    body: JSON.stringify({}),
    workspaceId,
  })) as { redirectUrl: string };

  // 3. Open in browser.
  const { default: open } = await import('open');
  await open(redirectUrl);

  // 4. Poll for new channels — see Task B6 for the acceptance criteria.
  const newChannels = await pollForNewChannels(workspaceId, existingIds);

  // 5. Report all new channels by type (D7 coexistence shape).
  console.log('✓ Connected:');
  for (const ch of newChannels) {
    const label =
      ch.type === 'whatsapp'
        ? `  WhatsApp  ${ch.displayPhoneNumber ?? '(no phone)'}  (${ch.id})`
        : ch.type === 'instagram'
          ? `  Instagram @${ch.instagramUsername ?? '(no handle)'}  (${ch.id})`
          : `  Messenger (${ch.id})`;
    console.log(label);
  }
}
```

Register positional in Commander:

```typescript
const channelsConnect = channels
  .command('connect')
  .description('Connect a channel via Meta OAuth')
  .argument('[type]', 'Channel type: "whatsapp" or "instagram" (interactive if omitted)')
  .action(async (type: string | undefined) => {
    if (type !== undefined && type !== 'whatsapp' && type !== 'instagram') {
      throw new ValidationError(
        `Invalid type "${type}". Must be "whatsapp" or "instagram".`,
        'INVALID_CONNECT_TYPE',
      );
    }
    await runChannelsConnect({ type });
  });
```

- [ ] **Step 4: Update `src/auth/login.ts` `--next channels` flow**

Find where `runChannelsConnect()` is called from login. Update to call the same picker:

```typescript
if (opts.next === 'channels') {
  const isTty = Boolean(process.stdout.isTTY);
  if (!isTty) {
    // D6 — exit 2; the wizard never silently picks a type
    throw new ValidationError(
      'login --next channels requires a TTY (interactive type chooser). ' +
        'In CI, run: hookmyapp channels connect <whatsapp|instagram>',
      'CONNECT_REQUIRES_TTY',
    );
  }
  await runChannelsConnect({}); // bare → interactive prompt in TTY
}
```

(Adjust import to use the new exported function name.)

- [ ] **Step 5: Run the test + login wizard tests**

```bash
npx vitest run src/__tests__/channels-connect.test.ts src/auth/__tests__/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/channels.ts src/auth/login.ts src/__tests__/channels-connect.test.ts
git commit -m "feat(channels/connect): type chooser (D2) + login wizard becomes type-aware"
```

---

### Task B6: Connect — coexistence multi-channel polling (D2 acceptance criteria)

**Files:**
- Modify: `src/commands/channels.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In src/__tests__/channels-connect.test.ts
describe('runChannelsConnect — coexistence multi-channel polling (D2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('reports BOTH channels that appear during the 4s stability window', async () => {
    const wa = { /* ...as before, id: 'ch_NEW_WA' */ };
    const ig = { /* ...as before, id: 'ch_NEW_IG' */ };
    // IMPORTANT mock ordering — matches the race-safe call order in
    // runChannelsConnect (Task B5):
    //   1. GET /meta/channels — snapshot BEFORE open()
    //   2. POST /meta/oauth/start — get redirectUrl
    //   3-N. GET /meta/channels — poll loop
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])                                      // 1. snapshot before open (empty workspace)
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example', codeChallenge: 'c' })  // 2. OAuth start
      .mockResolvedValueOnce([wa])                                    // 3. poll 1: WA appeared
      .mockResolvedValueOnce([wa, ig])                                // 4. poll 2: IG appeared
      .mockResolvedValueOnce([wa, ig])                                // 5. poll 3: stable
      .mockResolvedValueOnce([wa, ig]);                               // 6. poll 4: stable → exit
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const promise = runChannelsConnect({ type: 'whatsapp' });
    await vi.advanceTimersByTimeAsync(2000); // poll 1
    await vi.advanceTimersByTimeAsync(2000); // poll 2 → 4s window resets
    await vi.advanceTimersByTimeAsync(2000); // poll 3 → 4s window started after IG
    await vi.advanceTimersByTimeAsync(2000); // poll 4 → 4s stable → exit
    await promise;
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('ch_NEW_WA');
    expect(combined).toContain('ch_NEW_IG');
    expect(combined).toContain('WhatsApp');
    expect(combined).toContain('Instagram');
    logSpy.mockRestore();
  });

  it('race-safe: a channel that already exists in the initial snapshot is NOT reported', async () => {
    const preExisting = { /* ...as before, id: 'ch_PRE_EXISTING' */ };
    const wa = { /* ...as before, id: 'ch_NEW_WA' */ };
    vi.mocked(apiClient)
      .mockResolvedValueOnce([preExisting])                  // 1. snapshot — preExisting already present
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example', codeChallenge: 'c' })  // 2. OAuth
      .mockResolvedValueOnce([preExisting, wa])              // 3. poll 1: wa is new
      .mockResolvedValueOnce([preExisting, wa])              // 4. poll 2: stable
      .mockResolvedValueOnce([preExisting, wa]);             // 5. poll 3: stable → exit
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const promise = runChannelsConnect({ type: 'whatsapp' });
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    const combined = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(combined).toContain('ch_NEW_WA');
    expect(combined).not.toContain('ch_PRE_EXISTING'); // ← the race-safety assertion
    logSpy.mockRestore();
  });

  it('hard timeout at 5 minutes', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([])                              // 1. snapshot
      .mockResolvedValueOnce({ state: 's', redirectUrl: 'https://meta.example', codeChallenge: 'c' })  // 2. OAuth
      .mockResolvedValue([]);                                 // 3+. every poll returns no new channels
    const promise = runChannelsConnect({ type: 'instagram' });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
    await expect(promise).rejects.toThrow(/timed out|no channels appeared/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/__tests__/channels-connect.test.ts -t "coexistence"
```

Expected: FAIL — old `runChannelsConnect` stops at first new channel.

- [ ] **Step 3: Implement `pollForNewChannels`**

In `src/commands/channels.ts`:

```typescript
/**
 * D2 polling acceptance criteria:
 *   1. Caller snapshots existing channel ids BEFORE opening OAuth (race-safe).
 *   2. Poll /meta/channels every 2s after browser launch.
 *   3. Track newIds = channels not in the snapshot.
 *   4. Exit when: (a) newIds.length > 0 AND no new id in last 4s (stability), OR
 *      (b) 5min hard timeout, OR (c) SIGINT.
 *   5. Return ALL new channels.
 *
 * The `existingIds` Set MUST be captured BEFORE `open()` in the caller —
 * doing the snapshot inside this helper after the browser launches races a
 * fast backend write where the new channel could be included in the
 * "existing" snapshot and never reported.
 */
async function pollForNewChannels(
  workspaceId: string,
  existingIds: ReadonlySet<string>,
): Promise<Channel[]> {
  const POLL_INTERVAL_MS = 2000;
  const STABILITY_WINDOW_MS = 4000;
  const HARD_TIMEOUT_MS = 5 * 60 * 1000;
  const start = Date.now();
  let lastNewAt = 0;
  const seenNewIds = new Map<string, Channel>();
  while (true) {
    if (Date.now() - start > HARD_TIMEOUT_MS) {
      throw new CliError(
        'No channels appeared within 5 minutes. Did you complete the OAuth flow in your browser?',
        'CONNECT_TIMEOUT',
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const dtos = (await apiClient('/meta/channels', { workspaceId })) as unknown[];
    for (const dto of dtos) {
      const ch = parseChannelListItem(dto);
      if (!existingIds.has(ch.id) && !seenNewIds.has(ch.id)) {
        seenNewIds.set(ch.id, ch);
        lastNewAt = Date.now();
      }
    }
    if (seenNewIds.size > 0 && Date.now() - lastNewAt >= STABILITY_WINDOW_MS) {
      return Array.from(seenNewIds.values());
    }
  }
}
```

The polling helper itself is invoked from `runChannelsConnect` (already defined in Task B5 — the snapshot is taken BEFORE `open()`, then `pollForNewChannels(workspaceId, existingIds)` is called AFTER). No additional wiring needed here — Task B5 establishes the call shape.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/__tests__/channels-connect.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels.ts src/__tests__/channels-connect.test.ts
git commit -m "feat(channels/connect): coexistence polling (snapshot + stability + timeout) per D2"
```

---

### Task B7: `channels disconnect`, `enable`, `disable` IG branches

**Files:**
- Modify: `src/commands/channels.ts`

- [ ] **Step 1: Write a test that disconnect/enable/disable work on an IG channel**

```typescript
// src/__tests__/channels-toggles.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../commands/_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../api/client.js';
import {
  runChannelsDisconnect,
  runChannelsEnable,
  runChannelsDisable,
} from '../commands/channels.js';

const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('channels toggle actions accept IG channels', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('disconnect on @ordvir POSTs to /meta/channels/ch_IGaaaaaa/disconnect', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])           // resolveChannel
      .mockResolvedValueOnce({ ok: true });  // disconnect endpoint
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsDisconnect('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/disconnect');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Instagram @ordvir'));
    logSpy.mockRestore();
  });

  it('enable on @ordvir POSTs to /meta/channels/ch_IGaaaaaa/enable', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ forwardingEnabled: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsEnable('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/enable');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Instagram @ordvir'));
    logSpy.mockRestore();
  });

  it('disable on @ordvir POSTs to /meta/channels/ch_IGaaaaaa/disable', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])
      .mockResolvedValueOnce({ forwardingEnabled: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runChannelsDisable('@ordvir');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe('/meta/channels/ch_IGaaaaaa/disable');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Instagram @ordvir'));
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/__tests__/channels-toggles.test.ts
```

Expected: FAIL — current action handlers may crash on missing WA fields when called with an IG channel.

- [ ] **Step 3: Update the action handlers**

The existing `disconnect`, `enable`, `disable` actions in `src/commands/channels.ts` already accept any channel by `resolveChannel(ref)` — but they may print WA-flavored success copy. Update copy to use type-aware identifier:

```typescript
function channelLabel(c: Channel): string {
  if (c.type === 'whatsapp') return `WhatsApp ${c.displayPhoneNumber ?? c.wabaName ?? c.id}`;
  if (c.type === 'instagram') return `Instagram @${c.instagramUsername ?? c.id}`;
  return `Messenger ${c.id}`;
}

// disconnect action:
console.log(`✓ Disconnected ${channelLabel(channel)}`);
```

Apply the same `channelLabel` to enable + disable success messages.

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/__tests__/channels-toggles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels.ts src/__tests__/channels-toggles.test.ts
git commit -m "feat(channels): IG-aware disconnect/enable/disable + unified channelLabel helper"
```

---

### Task B8: `channels env` IG acceptance test (D5 — CLI code unchanged)

**Files:**
- Test: `src/commands/__tests__/channels-env-ig.test.ts`

- [ ] **Step 1: Write the acceptance test**

```typescript
// src/commands/__tests__/channels-env-ig.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../api/client.js';
import { runChannelEnv } from '../env.js';

const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('runChannelEnv on IG channel — backend returns INSTAGRAM_* keys (D5)', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('emits INSTAGRAM_* env keys verbatim from /meta/channels/:id/env', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([ig])  // resolveChannel list fetch
      .mockResolvedValueOnce({
        channelType: 'instagram',
        values: {
          INSTAGRAM_ACCESS_TOKEN: 'EAAxxx',
          INSTAGRAM_ACCOUNT_ID: '17841',
          INSTAGRAM_API_URL: 'https://graph.facebook.com/v25.0',
        },
        defaults: { PORT: '3000', VERIFY_TOKEN: 'vt_xxx' },
      });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelEnv('@ordvir', {});
    const out = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('INSTAGRAM_ACCESS_TOKEN=EAAxxx');
    expect(out).toContain('INSTAGRAM_ACCOUNT_ID=17841');
    expect(out).toContain('INSTAGRAM_API_URL=https://graph.facebook.com/v25.0');
    expect(out).toContain('PORT=3000');
    expect(out).toContain('VERIFY_TOKEN=vt_xxx');
    outSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx vitest run src/commands/__tests__/channels-env-ig.test.ts
```

Expected: PASS (no code change required — D5 says CLI is already backend-driven).

- [ ] **Step 3: Commit**

```bash
git add src/commands/__tests__/channels-env-ig.test.ts
git commit -m "test(channels/env): acceptance test for IG env block (D5 — no CLI change)"
```

---

### Task B9: `channels token`, `channels health`, `channels webhook show/set` — help text + IG-aware success copy

**Files:**
- Modify: `src/commands/token.ts`, `src/commands/health.ts`, `src/commands/webhook.ts`

- [ ] **Step 1: Update help text for each**

For each of the three files:
- `src/commands/token.ts` — update description from "...for a WhatsApp channel" to "...for a channel (WhatsApp or Instagram)".
- `src/commands/health.ts` — same shape.
- `src/commands/webhook.ts` — same shape; also ensure success messages use `channelLabel` helper from Task B7.

- [ ] **Step 2: Write a regression test for one of them**

```typescript
// src/commands/__tests__/channels-token-ig.test.ts
// runChannelToken on IG channel emits the backend's token response;
// success copy uses 'Instagram @ordvir' not 'WhatsApp ...'
```

- [ ] **Step 3: Run the test**

```bash
npx vitest run src/commands/__tests__/channels-token-ig.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/token.ts src/commands/health.ts src/commands/webhook.ts src/commands/__tests__/channels-token-ig.test.ts
git commit -m "feat(channels): IG-aware help text + success copy for token/health/webhook"
```

---

### Task B10: `channels listen` IG branch

**Files:**
- Modify: `src/commands/channels-listen/index.ts`, `src/commands/channels-listen/picker.ts`

- [ ] **Step 1: Update listen picker to accept positional identifier via parseIdentifier**

In `src/commands/channels-listen/picker.ts`, swap any old fuzzy-resolution code with a delegation to `resolveChannel(ref)`. The picker now just hands the user-supplied positional to `resolveChannel`.

- [ ] **Step 2: Update the listen runtime to render IG senderDisplay verbatim**

In `src/commands/channels-listen/index.ts`, the per-event render path. The DTO is already type-agnostic (it's a `webhook_events` row). The current render likely prints `event.fromPhone` or similar; switch to `event.senderDisplay ?? event.senderId ?? '(unknown)'`. This matches D8.

Also update the tunnel-active banner to be channel-type aware:

```typescript
const subjectLabel = channel.type === 'whatsapp'
  ? `WhatsApp ${channel.displayPhoneNumber}`
  : channel.type === 'instagram'
    ? `Instagram @${channel.instagramUsername ?? '(no handle)'}`
    : `Messenger ${channel.id}`;
process.stdout.write(`✓ Tunnel active for ${subjectLabel}: https://${tunnelHost}\n`);
```

- [ ] **Step 3: Write a test that listen on an IG channel succeeds**

```typescript
// src/commands/channels-listen/__tests__/listen-ig.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
// Stub heavy tunnel + heartbeat side-effects so the test asserts banner copy only.
vi.mock('../lifecycle.js', () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

import { apiClient } from '../../../api/client.js';
import { printChannelListenBanner } from '../index.js';
import type { Channel } from '../../../api/channel.js';

const ig: Channel = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('channels listen — IG banner copy', () => {
  beforeEach(() => vi.mocked(apiClient).mockReset());

  it('prints "Instagram @ordvir" + tunnel URL', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printChannelListenBanner({
      channel: ig,
      tunnelHost: 'abc.cloudflare.example',
      localPort: 3000,
    });
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('Instagram @ordvir');
    expect(combined).toContain('abc.cloudflare.example');
    expect(combined).not.toContain('WhatsApp');
    outSpy.mockRestore();
  });
});
```

Note: the test extracts the banner-printing into a named export (`printChannelListenBanner`) so it's directly callable without the full tunnel side-effects. Mirror the pattern used by `printBanner` in `src/commands/sandbox-listen/index.ts`.

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/commands/channels-listen/__tests__/listen-ig.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/channels-listen/
git commit -m "feat(channels/listen): IG-aware banner + senderDisplay passthrough (D8)"
```

---

### Task B11: `channels logs list` — add `--follow` (SSE) + `--json` (JSONL) + IG render

**Files:**
- Modify: `src/commands/channels-logs/index.ts`, `src/commands/channels-logs/api.ts`, `src/commands/channels-logs/render.ts`
- Test: `src/commands/channels-logs/__tests__/follow-mode.test.ts`, `json-mode.test.ts`

- [ ] **Step 1: Add `--follow` and `--json` flags to `logs list`**

In `src/commands/channels-logs/index.ts`:

```typescript
.command('list')
.description('List recent webhook deliveries for a channel')
.argument('[identifier]', 'Positional: +phone | @username | ch_XXXXXXXX')
.option('--limit <n>', 'Max rows per page (1-100, default 50)')
.option('--since <time>', 'Only deliveries after this time')
.option('--until <time>', 'Only deliveries before this time')
.option('--cursor <cursor>', 'Continue from a previous page nextCursor')
.option('--all', 'Auto-paginate every page (capped at 1000 rows)')
.option('-f, --follow', 'Stream new deliveries as they arrive (Ctrl-C to stop)')
.option('--json', 'JSONL output (one delivery DTO per line)')
.option('-v, --verbose', 'Full inbound body + forward attempt dump (default: one-line summary)')
.action(async (identifier: string | undefined, opts: ListOptions) => {
  // pass identifier through to resolveChannel, route through new functions
});
```

- [ ] **Step 2: Implement `streamDeliveries` in `src/commands/channels-logs/api.ts`**

Mirror `src/commands/sandbox/logs.ts` SSE-stream wiring:

```typescript
export async function* streamDeliveries(args: {
  channelPublicId: string;
  workspaceId: string;
}): AsyncIterableIterator<DeliveryDetail> {
  // Open SSE stream to GET /deliveries/stream?scope=channel:${channelPublicId}
  // For each `delivery` event, fetch the full DTO via /deliveries/:id
  // yield each DeliveryDetail until SIGINT or stream closes.
  // Implementation pattern same as sandbox/logs.ts ~line 380-401.
}
```

- [ ] **Step 3: Update `runChannelLogsList` to handle `--follow` + `--json`**

```typescript
async function runChannelLogsList(channelRef: string, opts: ListOptions, json: boolean): Promise<void> {
  const channel = await resolveChannel(channelRef);
  if (opts.follow) {
    // First emit the last N from the snapshot, then stream new ones.
    const page = await fetchDeliveriesPage({ channelPublicId: channel.id, workspaceId: channel.workspaceId, limit });
    for (const summary of page.deliveries) {
      const detail = await fetchDeliveryDetail(summary.id, channel.workspaceId);
      if (json) process.stdout.write(JSON.stringify(toLogsJson(detail)) + '\n');
      else if (opts.verbose) renderDeliveryDetail(detail);
      else printSummaryRow(detail);
    }
    for await (const detail of streamDeliveries({ channelPublicId: channel.id, workspaceId: channel.workspaceId })) {
      if (json) process.stdout.write(JSON.stringify(toLogsJson(detail)) + '\n');
      else if (opts.verbose) renderDeliveryDetail(detail);
      else printSummaryRow(detail);
    }
    return;
  }
  // existing pagination path, but render via printSummaryRow by default
}
```

- [ ] **Step 4: Add `printSummaryRow` to `src/commands/channels-logs/render.ts`**

Same shape as Task A6's `printSummaryDelivery` — extract the format into a shared helper if reasonable, otherwise duplicate the few lines (DRY is good, but cross-command duplication of a single render function is acceptable until a third caller appears).

- [ ] **Step 5: Write tests for follow + json**

`src/commands/channels-logs/__tests__/follow-mode.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('../api.js', async () => {
  const actual = await vi.importActual<typeof import('../api.js')>('../api.js');
  return {
    ...actual,
    streamDeliveries: vi.fn(),
    fetchDeliveriesPage: vi.fn(),
    fetchDeliveryDetail: vi.fn(),
  };
});

import { apiClient } from '../../../api/client.js';
import { runChannelLogsList } from '../index.js';
import { streamDeliveries, fetchDeliveriesPage, fetchDeliveryDetail } from '../api.js';
import type { Channel } from '../../../api/channel.js';

const ig: Channel = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

const sampleDetail = {
  id: 'wph_001', routingDecision: 'forward',
  inboundBody: '{"text":"hi"}', fromPhone: null,
  senderDisplay: '@ordvir', senderId: '1907', receivedAt: '2026-05-26T14:30:01Z',
  humanStatus: 'delivered', humanStatusCopy: 'Delivered', humanStatusTooltip: null,
  humanStatusColor: 'green' as const,
  attempts: [{
    id: 'a1', attemptNumber: 1,
    forwardUrl: 'https://n8n.example/webhook',
    forwardRequestBody: '', forwardStatus: 200, forwardDurationMs: 150,
    forwardResponseBody: null, outcome: 'success',
    attemptedAt: '2026-05-26T14:30:01.150Z',
  }],
};

describe('channels logs list --follow streams deliveries', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(streamDeliveries).mockReset();
    vi.mocked(fetchDeliveriesPage).mockReset();
    vi.mocked(fetchDeliveryDetail).mockReset();
  });

  it('emits the initial snapshot + each streamed delivery', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]); // resolveChannel
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({ deliveries: [{ id: 'wph_001' }], nextCursor: null } as any);
    vi.mocked(fetchDeliveryDetail).mockResolvedValueOnce(sampleDetail as any);
    vi.mocked(streamDeliveries).mockReturnValueOnce(
      (async function* () {
        yield { ...sampleDetail, id: 'wph_002' } as any;
        yield { ...sampleDetail, id: 'wph_003' } as any;
      })(),
    );
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelLogsList('@ordvir', { follow: true, limit: '1' }, false);
    const combined = outSpy.mock.calls.map((c) => c[0]).join('');
    expect(combined).toContain('@ordvir');     // sender in summary
    expect(combined).toContain('n8n.example');  // target host
    expect(streamDeliveries).toHaveBeenCalledWith({
      channelPublicId: 'ch_IGaaaaaa',
      workspaceId: 'ws_TEST0001',
    });
    outSpy.mockRestore();
  });
});
```

`src/commands/channels-logs/__tests__/json-mode.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({ apiClient: vi.fn() }));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));
vi.mock('../api.js', async () => {
  const actual = await vi.importActual<typeof import('../api.js')>('../api.js');
  return {
    ...actual,
    fetchDeliveriesPage: vi.fn(),
    fetchDeliveryDetail: vi.fn(),
  };
});

import { apiClient } from '../../../api/client.js';
import { runChannelLogsList } from '../index.js';
import { fetchDeliveriesPage, fetchDeliveryDetail } from '../api.js';

const ig = {
  id: 'ch_IGaaaaaa', type: 'instagram', workspaceId: 'ws_TEST0001',
  metaWabaId: '', metaResourceId: '17841', connectionType: 'instagram_login',
  metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
  instagramUsername: 'ordvir', instagramName: 'Or', instagramProfilePictureUrl: null,
};

describe('channels logs list --json emits JSONL with GUI fields stripped', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
    vi.mocked(fetchDeliveriesPage).mockReset();
    vi.mocked(fetchDeliveryDetail).mockReset();
  });

  it('emits one JSON object per line; humanStatusTooltip + humanStatusColor stripped', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    vi.mocked(fetchDeliveriesPage).mockResolvedValueOnce({
      deliveries: [{ id: 'wph_001' }, { id: 'wph_002' }], nextCursor: null,
    } as any);
    vi.mocked(fetchDeliveryDetail)
      .mockResolvedValueOnce({
        id: 'wph_001', routingDecision: 'forward', inboundBody: '{}',
        fromPhone: null, senderDisplay: '@ordvir', senderId: '1907',
        receivedAt: '2026-05-26T14:30:01Z',
        humanStatus: 'delivered', humanStatusCopy: 'Delivered',
        humanStatusTooltip: 'shown on hover', humanStatusColor: 'green',
        attempts: [],
      } as any)
      .mockResolvedValueOnce({
        id: 'wph_002', routingDecision: 'forward', inboundBody: '{}',
        fromPhone: null, senderDisplay: '@ordvir', senderId: '1907',
        receivedAt: '2026-05-26T14:30:05Z',
        humanStatus: 'failed', humanStatusCopy: 'Failed',
        humanStatusTooltip: 'shown on hover', humanStatusColor: 'red',
        attempts: [],
      } as any);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runChannelLogsList('@ordvir', {}, true);
    const writes = outSpy.mock.calls.map((c) => c[0] as string).filter((s) => s.startsWith('{'));
    expect(writes).toHaveLength(2);
    for (const line of writes) {
      const dto = JSON.parse(line);
      expect(dto.humanStatusTooltip).toBeUndefined();
      expect(dto.humanStatusColor).toBeUndefined();
      expect(dto.id).toMatch(/^wph_/);
    }
    outSpy.mockRestore();
  });
});
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run src/commands/channels-logs/__tests__/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/channels-logs/
git commit -m "feat(channels/logs): --follow (SSE) + --json (JSONL) + summary-by-default (D8 + D9)"
```

---

### Task B12: Phase B integration smoke + version bump + CHANGELOG

**Files:**
- Modify: `package.json`, `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json`:

```diff
-  "version": "0.12.2",
+  "version": "0.13.0",
```

- [ ] **Step 2: Append Phase B CHANGELOG entry**

Append to `CHANGELOG.md`:

```markdown
## 0.13.0 (Phase B — channels Instagram support)

### Added
- `hookmyapp channels connect [type]` — `whatsapp` opens Meta Embedded Signup; `instagram` opens the IG OAuth URL. Bare in TTY prompts; non-TTY exits 2 (D6).
- Coexistence post-connect polling (D2): when one OAuth flow returns both a WA + IG channel, both are reported.
- `channels logs list --follow` — SSE live tail of webhook deliveries.
- `channels logs list --json` — JSONL output (one delivery DTO per line).
- `channels logs list --verbose` — full detailed dump (default switched to one-line summary).
- Every `channels` subcommand (`list`, `show`, `disconnect`, `enable`, `disable`, `env`, `token`, `health`, `webhook show/set`, `listen`, `logs`) accepts Instagram channels — same flag surface, same exit codes, same JSON shape per type.

### Changed
- `ApiChannel` interface replaced with boundary-parsed `Channel` discriminated union (`parseChannelListItem` + `parseChannelDetail` at `src/api/channel.ts`). Tolerates unknown wire extras.
- `channels list` table renders `@username` for IG rows and `+phone` for WA rows.
- `login --next channels` becomes channel-type-aware: prompts in TTY, exits 2 in non-TTY (D6).
```

- [ ] **Step 3: Run the full gate**

```bash
npx tsc --noEmit && npx vitest run && npm run build
```

Expected: clean.

- [ ] **Step 4: Manual smoke from a real terminal against local backend**

```bash
node dist/cli.js channels list
node dist/cli.js channels show @ordvir
node dist/cli.js channels logs list @ordvir --limit 3
node dist/cli.js channels logs list @ordvir --json --limit 3
node dist/cli.js channels webhook show @ordvir
```

Expected: all succeed for an IG channel without crashing or printing WA-flavored copy.

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): 0.13.0 — channels Instagram + sandbox picker/logs retrofit"
```

---

## Self-Review Checklist

Run mentally before handing off:

- [ ] **Spec coverage** —
  - D1 (full parity) → Tasks B3, B4, B7, B9, B10, B11
  - D2 (connect chooser + polling) → Tasks B5, B6
  - D3 (shape-detected positional) → Tasks A1, A2, A3, A4, A5, B2
  - D4 (two parsers) → Task B1, B2
  - D5 (channels env unchanged) → Task B8
  - D6 (non-TTY exit 2) → Task B5
  - D7 (coexistence reporting) → Task B6
  - D8 (listen/logs IG render + new --follow/--json) → Tasks B10, B11
  - D9 (logs UX flip table-by-default) → Tasks A6, B11
  - D10 (sandbox retrofit first) → Phase A precedes Phase B
- [ ] **No placeholders** — every test has actual code; no "TODO" or "fill in later".
- [ ] **Type consistency** — `parseIdentifier` return shape `{ kind, value }` matches across Tasks A1, A2, B2.
- [ ] **No dead-code paths from spec** — the removed `--next-channel-type` flag and the removed `set --url ""` workaround do not appear in any task.

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-26-cli-channels-instagram.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance, then code quality). I orchestrate; you watch.
2. **Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, with checkpoint pauses for review every few tasks.

Which approach?
