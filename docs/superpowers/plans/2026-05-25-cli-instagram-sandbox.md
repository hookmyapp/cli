# Instagram support in the CLI sandbox commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@gethookmyapp/cli` 0.12.2 with full Instagram parity for `sandbox env`, `sandbox send`, `sandbox start`, `sandbox status`, `sandbox stop`, `sandbox webhook show/set/clear`, and `sandbox listen` — symmetric to today's WhatsApp UX, gated on local + staging environments (production gating per D10 in the spec).

**Architecture:** Wire data passes through a boundary parser (`src/api/sandbox-session.ts`) that produces a discriminated union `SandboxSession = WhatsAppSandboxSession | InstagramSandboxSession`. The current 782-line `src/commands/sandbox.ts` splits into per-subcommand files under `src/commands/sandbox/`. Three shared helpers (`sessionIdentifier`, `sessionLabel`, `buildSandboxSendRequest`) concentrate every channel narrow. One unified `pickSession` accepts `--phone | --username | --session` and replaces today's `pickSessionByPhone` + the local `pickSendSession` + the simple paths in `sandbox-listen/picker.ts`. `auth/login.ts` adds the parser at its wire boundary and filters to WA-only before the legacy `--phone` auto-listen path.

**Tech Stack:** TypeScript, Commander v14, `@inquirer/prompts`, `qrcode-terminal`, `picocolors`, `ora`, Vitest 3. Published to npm with sigstore provenance via the existing release flow.

**Spec:** `docs/superpowers/specs/2026-05-25-instagram-sandbox-cli-design.md` (commit `6d315d7`).

---

## Background the engineer needs

- **CLI repo is standalone** (`@gethookmyapp/cli`, version 0.12.1 today). All paths in this plan are inside `/Users/ordvir/COD/cli` unless noted.
- **No backend changes.** The multi-channel-instagram milestone shipped the wire contracts (`type`, `instagramSenderId`, `instagramAccountId`, `instagramSenderUsername` on `GET /sandbox/sessions`) and the sandbox-proxy IG send route (`POST /v25.0/:igUserId/messages`). Verify against `backend/src/sandbox/sandbox.service.ts:72-83` (wire response shape) and `sandbox-proxy/src/proxy/proxy.controller.ts:159-260` (IG route).
- **Existing tests use `vi.mock('../sandbox.js')`** — see `src/commands/__tests__/sandbox-env.test.ts`, `sandbox-send.test.ts`, `sandbox-start.test.ts`, `sandbox-start-listen.test.ts`. When `src/commands/sandbox.ts` splits into a directory, **every one of these mock paths must update** to point at the new per-subcommand module. Task 16 handles this migration.
- **NodeNext ESM doesn't resolve directories.** Imports must spell out `.js`: `from './commands/sandbox/index.js'`, not `from './commands/sandbox/index'` or `from './commands/sandbox.js'`. The current import at `src/index.ts:11` is `from './commands/sandbox.js'` and must update.
- **Error subclasses live in `src/output/error.ts`.** Constructors are positional `(message, code?, statusCode?)`. `UnexpectedError(msg, code='UNKNOWN_ERROR')` exits 1. `ValidationError(msg, code='VALIDATION_ERROR')` exits 2. `ConfigurationError(msg, code='CONFIG_ERROR')` exits 1. `CliError` defaults to `exitCode = 1`; set `err.exitCode = 2` for the `SESSION_MISMATCH` mismatch path (precedent at `src/commands/sandbox-listen/picker.ts:60-66`).
- **`apiClient(path, { workspaceId })`** (`src/api/client.ts`) is the single HTTP entry point. Handles auth, token refresh, `X-Workspace-Id` header, and maps non-2xx to typed `AppError` subclasses. Returns parsed JSON.
- **`getDefaultWorkspaceId()`** (`src/commands/_helpers.ts`) resolves and returns the active workspace's public ID (`ws_xxxxxxxx`). Used in every sandbox subcommand before fetching sessions.
- **`addExamples(cmd, text)`** (`src/output/help.ts`) attaches an `EXAMPLES:` block visible to both `--help` and `cmd.helpInformation()`. The `help.test.ts` walker (`src/__tests__/help.test.ts`) asserts every command exposes one with ≥2 lines starting `  $ hookmyapp `. Every new command from this plan MUST call `addExamples()` or `help.test.ts` fails.
- **Vitest config** (`vitest.config.ts`) includes both `src/__tests__/**/*.{test,spec}.ts` and `src/**/__tests__/**/*.{test,spec}.ts`. Co-locating tests under `src/commands/sandbox/__tests__/` and `src/api/__tests__/` matches the `sandbox-listen/__tests__/` precedent.
- **Test setup** (`vitest.setup.ts`) redirects `HOOKMYAPP_CONFIG_DIR` to a tmp dir before any test loads. No production credentials get touched by the suite.
- **Sandbox-proxy IG response shape.** WA returns `{ messages: [{ id }] }`; IG returns `{ recipient_id, message_id }` (flat). Single extraction line: `body?.messages?.[0]?.id ?? body?.message_id ?? '?'`.
- **`ig.me` URL format.** Strip the leading `@` from the handle path segment: `https://ig.me/m/hookmyappsandboxstaging?text=...` (NOT `ig.me/m/@hookmyappsandboxstaging`). The code argument MUST be `encodeURIComponent()`d.
- **Project memory `feedback_no_legacy_handling`** — no `phone ?? whatsappPhone` fallbacks. Parser is strict; a backend STI violation surfaces immediately at the CLI.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `src/api/sandbox-session.ts` | Discriminated union (`SandboxSession`, `WhatsAppSandboxSession`, `InstagramSandboxSession`), `parseSandboxSession` + plural, `assertNever`, `INSTAGRAM_GRAPH_VERSION` constant |
| `src/api/__tests__/sandbox-session.test.ts` | Parser + helpers tests |
| `src/commands/sandbox/index.ts` | `registerSandboxCommand(program)` — Commander wiring + per-subcommand action handlers |
| `src/commands/sandbox/helpers.ts` | `sessionIdentifier`, `sessionLabel` (pure), `buildSandboxSendRequest` (reads env-profile) |
| `src/commands/sandbox/picker.ts` | Unified `pickSession({ sessions, phoneFlag, usernameFlag, sessionFlag, isHuman, alwaysShowPicker })` |
| `src/commands/sandbox/env.ts` | `runSandboxEnv` + `buildEnvBlock(session)` with WA + IG branches |
| `src/commands/sandbox/send.ts` | `runSandboxSend` using `buildSandboxSendRequest` |
| `src/commands/sandbox/start.ts` | `runSandboxStart` with `--type` chooser, IG `ig.me` QR, prod fail-fast |
| `src/commands/sandbox/status.ts` | `runSandboxStatus` table |
| `src/commands/sandbox/stop.ts` | `runSandboxStop` |
| `src/commands/sandbox/webhook.ts` | `runSandboxWebhookShow / Set / Clear` |
| `src/commands/sandbox/__tests__/helpers.test.ts` | helpers tests |
| `src/commands/sandbox/__tests__/picker.test.ts` | picker tests |
| `src/commands/sandbox/__tests__/env.test.ts` | env tests (replaces `src/commands/__tests__/sandbox-env.test.ts`) |
| `src/commands/sandbox/__tests__/send.test.ts` | send tests (replaces `src/commands/__tests__/sandbox-send.test.ts`) |
| `src/commands/sandbox/__tests__/start.test.ts` | start tests (replaces `src/commands/__tests__/sandbox-start.test.ts` + `sandbox-start-listen.test.ts`) |
| `src/commands/sandbox/__tests__/webhook.test.ts` | webhook tests |

**Modify:**

| File | Change |
|---|---|
| `src/config/env-profiles.ts` | Add `getEffectiveSandboxInstagramUsername()`; convert pre-existing raw `throw new Error` at line 125 to `ConfigurationError` |
| `src/commands/sandbox-listen/picker.ts` | Replace local `Session` interface with import of `SandboxSession` from the new wire module; generalize `pickSession` to accept `usernameFlag`; update `renderSessionTable` to render `Type | Identifier` columns |
| `src/commands/sandbox-listen/index.ts` | Route `apiClient('/sandbox/sessions?active=true')` through `parseSandboxSessions`; add `.option('--username <handle>', ...)`; pass `usernameFlag` to `pickSession` |
| `src/commands/sandbox-listen/__tests__/picker.test.ts` | Add IG-session cases |
| `src/auth/login.ts` | Route `apiClient('/sandbox/sessions?active=true')` (the wizard's session match path, line ~383) through `parseSandboxSessions`; filter to `type === 'whatsapp'` before the legacy `--phone` auto-listen so an IG session can never fall into the WA-only code path by accident |
| `src/index.ts` | Update import from `./commands/sandbox.js` to `./commands/sandbox/index.js` (line 11) |
| `package.json` | Bump version `0.12.1` → `0.12.2` |
| `CHANGELOG.md` | Add `0.12.2` entry naming IG support, selector unification, `sandbox webhook` positional deprecation |

**Delete:**

| File | Reason |
|---|---|
| `src/commands/sandbox.ts` | Split into `src/commands/sandbox/` |
| `src/commands/__tests__/sandbox-env.test.ts` | Migrated to `src/commands/sandbox/__tests__/env.test.ts` |
| `src/commands/__tests__/sandbox-send.test.ts` | Migrated to `src/commands/sandbox/__tests__/send.test.ts` |
| `src/commands/__tests__/sandbox-start.test.ts` | Migrated to `src/commands/sandbox/__tests__/start.test.ts` |
| `src/commands/__tests__/sandbox-start-listen.test.ts` | Folded into `src/commands/sandbox/__tests__/start.test.ts` |

---

## Task 0: Branch + version-and-CHANGELOG scaffold

**Files:**
- Modify: `/Users/ordvir/COD/cli/package.json`
- Modify: `/Users/ordvir/COD/cli/CHANGELOG.md`

**Why:** Establish the feature branch, the version bump, and a placeholder CHANGELOG entry up-front. The actual CHANGELOG body fills in as features land (final pass in Task 17). The version bump can land first because no tooling looks at `package.json:version` until the release script runs.

- [ ] **Step 1: Create and switch to the feature branch**

```bash
cd /Users/ordvir/COD/cli
git checkout -b feat/instagram-sandbox
git status
```

Expected: `On branch feat/instagram-sandbox`, working tree clean (the spec commits stay on `main` per the existing pattern).

- [ ] **Step 2: Bump `package.json` version**

Open `/Users/ordvir/COD/cli/package.json` and change line 3 from:

```json
  "version": "0.12.1",
```

to:

```json
  "version": "0.12.2",
```

- [ ] **Step 3: Add a placeholder CHANGELOG entry**

Open `/Users/ordvir/COD/cli/CHANGELOG.md` and add at the top, immediately under the `# Changelog` heading and any unreleased section header:

```markdown
## 0.12.2 (unreleased)

### Added

- `hookmyapp sandbox start --type=instagram` — bind an Instagram sandbox session by DMing the env-configured sandbox IG handle (`@hookmyappsandboxstaging` on local + staging; production gated until the prod handle is provisioned).
- `--username <@handle>` selector flag on `sandbox env`, `sandbox send`, `sandbox stop`, `sandbox webhook show/set/clear`, and `sandbox listen` — selects an Instagram session by handle. Falls back to IGSID match when the username is still being backfilled by the backend.
- `--session <ssn_XXXXXXXX>` promoted to a universal selector across the same five subcommand groups (was sandbox-listen-only).
- `INSTAGRAM_API_URL`, `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_ACCOUNT_ID` env vars emitted by `sandbox env` when the selected session is Instagram.
- Boundary parser that validates every `GET /sandbox/sessions*` response into a `WhatsAppSandboxSession | InstagramSandboxSession` discriminated union. Malformed wire data surfaces as `UnexpectedError` (`MALFORMED_SANDBOX_SESSION`, exit 1).

### Deprecated

- Positional `[phone]` argument on `sandbox webhook show`, `sandbox webhook set`, `sandbox webhook clear`. Use `--phone`, `--username`, or `--session` instead. Positional still works in 0.12.2 with a stderr deprecation warning; removed no earlier than 0.13.0.

### Changed

- `sandbox status` table now renders `Type | Identifier | Status | Listener` columns instead of `Phone | Status | Listener`. Identifier is `+<phone>` for WhatsApp and `@<handle>` for Instagram (falls back to IGSID).
```

- [ ] **Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to 0.12.2 + CHANGELOG scaffold for IG support"
```

Expected: one commit on `feat/instagram-sandbox`, working tree clean.

---

## Task 1: Wire types + boundary parser + IG_GRAPH_VERSION constant

**Files:**
- Create: `src/api/sandbox-session.ts`
- Create: `src/api/__tests__/sandbox-session.test.ts`

**Why:** This module is the wire boundary for every `/sandbox/sessions*` consumer. Defines the discriminated union, the parser that produces it, the `assertNever` exhaustiveness helper, and the `INSTAGRAM_GRAPH_VERSION` constant imported by both `buildEnvBlock` and `buildSandboxSendRequest`. Per spec D7: shared base fields validated on both variants except `workspaceId` (stripped by backend list response per `sandbox.service.ts:72-83`); `sandboxPhoneNumberId` + `whatsappApiVersion` validated on WA only because IG consumers never read them.

- [ ] **Step 1: Write the failing test**

Create `src/api/__tests__/sandbox-session.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseSandboxSession,
  parseSandboxSessions,
  assertNever,
  INSTAGRAM_GRAPH_VERSION,
  type WhatsAppSandboxSession,
  type InstagramSandboxSession,
} from '../sandbox-session.js';
import { UnexpectedError } from '../../output/error.js';

const baseShared = {
  id: 'ssn_TEST0001',
  accessToken: 'ACT_xxx',
  hmacSecret: 'HMAC_yyy',
  status: 'active',
  origin: 'manual',
};

const validWa = {
  ...baseShared,
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  // optional fields tolerated:
  phone: '15551234567',
  workspaceId: 'ws_TEST0001',
  workspaceName: 'Test workspace',
};

const validIg = {
  ...baseShared,
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
};

describe('parseSandboxSession', () => {
  it('returns a typed WhatsApp variant for a valid WA wire row', () => {
    const parsed = parseSandboxSession(validWa);
    expect(parsed.type).toBe('whatsapp');
    const wa = parsed as WhatsAppSandboxSession;
    expect(wa.whatsappPhone).toBe('15551234567');
    expect(wa.whatsappPhoneNumberId).toBe('1080996501762047');
    expect(wa.sandboxPhoneNumberId).toBe('1080996501762047');
    expect(wa.whatsappApiVersion).toBe('v24.0');
  });

  it('returns a typed Instagram variant for a valid IG wire row', () => {
    const parsed = parseSandboxSession(validIg);
    expect(parsed.type).toBe('instagram');
    const ig = parsed as InstagramSandboxSession;
    expect(ig.instagramSenderId).toBe('8745912038476523');
    expect(ig.instagramAccountId).toBe('17841478719287768');
    expect(ig.instagramSenderUsername).toBe('ordvir');
  });

  it('tolerates null instagramSenderUsername (backend backfills async)', () => {
    const parsed = parseSandboxSession({
      ...validIg,
      instagramSenderUsername: null,
    });
    expect((parsed as InstagramSandboxSession).instagramSenderUsername).toBeNull();
  });

  it('does NOT require workspaceId — backend strips it from list responses', () => {
    const { workspaceId: _wsId, ...withoutWorkspace } = validWa;
    expect(() => parseSandboxSession(withoutWorkspace)).not.toThrow();
  });

  it('does NOT require sandboxPhoneNumberId or whatsappApiVersion on IG sessions', () => {
    expect(() => parseSandboxSession(validIg)).not.toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => parseSandboxSession({ ...baseShared, type: 'messenger' })).toThrow(
      UnexpectedError,
    );
  });

  it('rejects missing type', () => {
    const { ...withoutType } = baseShared;
    expect(() => parseSandboxSession(withoutType as object)).toThrow(UnexpectedError);
  });

  it('rejects WA session missing whatsappPhone', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, whatsappPhone: null }),
    ).toThrow(/whatsappPhone/);
  });

  it('rejects WA session missing sandboxPhoneNumberId', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, sandboxPhoneNumberId: null }),
    ).toThrow(/sandboxPhoneNumberId/);
  });

  it('rejects WA session missing whatsappApiVersion', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, whatsappApiVersion: '' }),
    ).toThrow(/whatsappApiVersion/);
  });

  it('rejects IG session missing instagramSenderId', () => {
    expect(() =>
      parseSandboxSession({ ...validIg, instagramSenderId: '' }),
    ).toThrow(/instagramSenderId/);
  });

  it('rejects IG session missing instagramAccountId', () => {
    expect(() =>
      parseSandboxSession({ ...validIg, instagramAccountId: null }),
    ).toThrow(/instagramAccountId/);
  });

  it('rejects shared base field missing accessToken', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, accessToken: '' }),
    ).toThrow(/accessToken/);
  });

  it('rejects shared base field missing id', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, id: '' }),
    ).toThrow(/id missing/);
  });

  it('rejects shared base field missing origin', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, origin: '' }),
    ).toThrow(/origin/);
  });

  it('rejects status that is not in the allowed closed union', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, status: 'pending_activision' }),
    ).toThrow(/status must be one of/);
  });

  it('includes the session id in the error message', () => {
    expect(() =>
      parseSandboxSession({ ...validWa, accessToken: '' }),
    ).toThrow(/ssn_TEST0001/);
  });

  it('rejects non-object input', () => {
    expect(() => parseSandboxSession(null)).toThrow(UnexpectedError);
    expect(() => parseSandboxSession('not an object')).toThrow(UnexpectedError);
  });
});

describe('parseSandboxSessions', () => {
  it('parses an array of mixed valid sessions', () => {
    const out = parseSandboxSessions([validWa, validIg]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('whatsapp');
    expect(out[1].type).toBe('instagram');
  });

  it('rejects a non-array input', () => {
    expect(() => parseSandboxSessions(validWa)).toThrow(UnexpectedError);
  });

  it('propagates the inner parser error with the offending session id', () => {
    expect(() =>
      parseSandboxSessions([
        validWa,
        { ...validIg, id: 'ssn_BADIG01', instagramSenderId: '' },
      ]),
    ).toThrow(/ssn_BADIG01/);
    expect(() =>
      parseSandboxSessions([
        validWa,
        { ...validIg, id: 'ssn_BADIG01', instagramSenderId: '' },
      ]),
    ).toThrow(/instagramSenderId/);
  });
});

describe('assertNever', () => {
  it('throws UnexpectedError with the context string', () => {
    // Construct a value that bypasses TS exhaustiveness so we can exercise the runtime path.
    const v = 'unexpected' as never;
    expect(() => assertNever(v, 'test context')).toThrow(/test context/);
  });
});

describe('INSTAGRAM_GRAPH_VERSION', () => {
  it('is the current pinned IG Graph version', () => {
    expect(INSTAGRAM_GRAPH_VERSION).toBe('v25.0');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/ordvir/COD/cli
pnpm vitest run src/api/__tests__/sandbox-session.test.ts
```

Expected: FAIL — `Cannot find module '../sandbox-session.js'`.

- [ ] **Step 3: Implement the wire module**

Create `src/api/sandbox-session.ts`:

```typescript
// Wire boundary for /sandbox/sessions* responses. Parses untrusted JSON into
// a discriminated union (WhatsApp | Instagram). Every CLI sandbox subcommand
// + the login wizard + sandbox-listen route their wire fetches through this
// parser; the `as SandboxSession[]` casts that used to live at sandbox.ts:96,
// sandbox.ts:145, auth/login.ts:383, and sandbox-listen/index.ts:323 are
// deleted in this release.
//
// Per spec D7: shared base fields validated on every session except
// workspaceId (stripped from list responses by the backend per
// sandbox.service.ts:72-83). sandboxPhoneNumberId + whatsappApiVersion are
// required on WA variant only — IG consumers never read them and requiring
// them on IG rows would couple Instagram to WhatsApp sandbox config.
//
// Per spec D2: INSTAGRAM_GRAPH_VERSION is a single constant — bumping IG's
// Graph API version is a one-line change here, imported by both buildEnvBlock
// and buildSandboxSendRequest.

import { UnexpectedError } from '../output/error.js';

export const INSTAGRAM_GRAPH_VERSION = 'v25.0';

interface SandboxSessionBase {
  id: string;
  accessToken: string;
  hmacSecret: string;
  status: 'pending_activation' | 'active' | 'replaced' | 'expired';
  origin: string;
  // Optional fields tolerated when present (not required for parser success):
  workspaceId?: string;
  workspaceName?: string | null;
  webhookUrl?: string | null;
  hostname?: string | null;
  lastHeartbeatAt?: string | null;
  cloudflareTunnelId?: string | null;
  cloudflareTunnelToken?: string | null;
  activatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  // Legacy field still present on some wire rows; not consumed by the new helpers.
  phone?: string | null;
}

export interface WhatsAppSandboxSession extends SandboxSessionBase {
  type: 'whatsapp';
  whatsappPhone: string;
  whatsappPhoneNumberId: string;
  sandboxPhoneNumberId: string;
  whatsappApiVersion: string;
  // Channel-specific narrow: never populated on WA rows.
  instagramSenderId?: null;
  instagramAccountId?: null;
  instagramSenderUsername?: null;
}

export interface InstagramSandboxSession extends SandboxSessionBase {
  type: 'instagram';
  instagramSenderId: string;
  instagramAccountId: string;
  instagramSenderUsername: string | null;
  // Channel-specific narrow: never populated on IG rows.
  whatsappPhone?: null;
  whatsappPhoneNumberId?: null;
}

export type SandboxSession = WhatsAppSandboxSession | InstagramSandboxSession;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function malformed(id: string, reason: string): never {
  throw new UnexpectedError(
    `Backend returned malformed sandbox session ${id}: ${reason}. ` +
      `Report at https://github.com/hookmyapp/cli/issues`,
    'MALFORMED_SANDBOX_SESSION',
  );
}

export function parseSandboxSession(dto: unknown): SandboxSession {
  if (typeof dto !== 'object' || dto === null) {
    throw new UnexpectedError(
      `Backend returned malformed sandbox session: expected an object, got ${typeof dto}. ` +
        `Report at https://github.com/hookmyapp/cli/issues`,
      'MALFORMED_SANDBOX_SESSION',
    );
  }
  const d = dto as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id : '<unknown>';

  if (!isNonEmptyString(d.id)) malformed(id, 'id missing');
  if (!isNonEmptyString(d.accessToken)) malformed(id, 'accessToken missing');
  if (!isNonEmptyString(d.hmacSecret)) malformed(id, 'hmacSecret missing');
  if (!isNonEmptyString(d.status)) malformed(id, 'status missing');
  // Validate status against the closed union declared on SandboxSessionBase.
  // A typo like 'pending_activision' would otherwise pass through and lie to
  // every downstream `switch (status)`.
  const ALLOWED_STATUS = ['pending_activation', 'active', 'replaced', 'expired'] as const;
  if (!ALLOWED_STATUS.includes(d.status as (typeof ALLOWED_STATUS)[number])) {
    malformed(id, `status must be one of ${ALLOWED_STATUS.join('|')}, got "${d.status}"`);
  }
  if (!isNonEmptyString(d.origin)) malformed(id, 'origin missing');

  if (d.type === 'whatsapp') {
    if (!isNonEmptyString(d.whatsappPhone))
      malformed(id, 'WhatsApp session missing whatsappPhone');
    if (!isNonEmptyString(d.whatsappPhoneNumberId))
      malformed(id, 'WhatsApp session missing whatsappPhoneNumberId');
    if (!isNonEmptyString(d.sandboxPhoneNumberId))
      malformed(id, 'WhatsApp session missing sandboxPhoneNumberId');
    if (!isNonEmptyString(d.whatsappApiVersion))
      malformed(id, 'WhatsApp session missing whatsappApiVersion');
    return d as unknown as WhatsAppSandboxSession;
  }

  if (d.type === 'instagram') {
    if (!isNonEmptyString(d.instagramSenderId))
      malformed(id, 'Instagram session missing instagramSenderId');
    if (!isNonEmptyString(d.instagramAccountId))
      malformed(id, 'Instagram session missing instagramAccountId');
    // instagramSenderUsername may be null (backend backfills async).
    if (
      d.instagramSenderUsername !== null &&
      d.instagramSenderUsername !== undefined &&
      typeof d.instagramSenderUsername !== 'string'
    )
      malformed(id, 'instagramSenderUsername must be string or null');
    return d as unknown as InstagramSandboxSession;
  }

  throw new UnexpectedError(
    `Backend returned malformed sandbox session ${id}: unknown type "${String(
      d.type,
    )}". Report at https://github.com/hookmyapp/cli/issues`,
    'MALFORMED_SANDBOX_SESSION',
  );
}

export function parseSandboxSessions(dto: unknown): SandboxSession[] {
  if (!Array.isArray(dto)) {
    throw new UnexpectedError(
      `Backend returned malformed sandbox sessions list: expected array, got ${typeof dto}. ` +
        `Report at https://github.com/hookmyapp/cli/issues`,
      'MALFORMED_SANDBOX_SESSION',
    );
  }
  return dto.map(parseSandboxSession);
}

// Exhaustiveness helper. Switching on session.type and passing the default
// branch through assertNever() catches missing channels at compile time when
// a third variant joins the union. The runtime throw is defense-in-depth.
export function assertNever(value: never, ctx: string): never {
  throw new UnexpectedError(
    `Unsupported sandbox session variant in ${ctx}: ${String(value)}`,
    'UNSUPPORTED_SESSION_VARIANT',
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/ordvir/COD/cli
pnpm vitest run src/api/__tests__/sandbox-session.test.ts
```

Expected: PASS, all ~18 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/api/sandbox-session.ts src/api/__tests__/sandbox-session.test.ts
git commit -m "feat(sandbox): wire boundary parser + discriminated union (D7)"
```

---

## Task 2: env-profile additions — IG handle resolver + raw-throw cleanup

**Files:**
- Modify: `src/config/env-profiles.ts`

**Why:** Production-environment `sandbox start --type=instagram` fails fast with `ConfigurationError` per spec D10. The handle for local + staging resolves to `'@hookmyappsandboxstaging'` per project memory `reference_sandbox_ig_account`. While we're here, convert the pre-existing raw `throw new Error(...)` at line 125 to `ConfigurationError` — minimal in-flight cleanup of a known lint violation in a file we're modifying anyway.

- [ ] **Step 1: Read the file to anchor the changes**

```bash
cd /Users/ordvir/COD/cli
sed -n '115,140p' src/config/env-profiles.ts
sed -n '160,195p' src/config/env-profiles.ts
```

Note the exact lines:
- Around 125: `throw new Error(...)` (the lint violation)
- After 167 (the end of `getEffectiveSandboxWhatsAppNumber`): insertion point for the new IG helper

- [ ] **Step 2: Write the failing test**

Append to `src/config/__tests__/env-profiles.test.ts` (create the file if it does not exist; check `ls src/config/__tests__/` first):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEffectiveSandboxInstagramUsername,
} from '../env-profiles.js';
import { ConfigurationError } from '../../output/error.js';

describe('getEffectiveSandboxInstagramUsername', () => {
  const originalEnv = process.env.HOOKMYAPP_ENV;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = originalEnv;
  });

  it('returns @hookmyappsandboxstaging in local', () => {
    process.env.HOOKMYAPP_ENV = 'local';
    expect(getEffectiveSandboxInstagramUsername()).toBe('@hookmyappsandboxstaging');
  });

  it('returns @hookmyappsandboxstaging in staging', () => {
    process.env.HOOKMYAPP_ENV = 'staging';
    expect(getEffectiveSandboxInstagramUsername()).toBe('@hookmyappsandboxstaging');
  });

  it('throws ConfigurationError in production (handle not yet provisioned)', () => {
    process.env.HOOKMYAPP_ENV = 'production';
    expect(() => getEffectiveSandboxInstagramUsername()).toThrow(ConfigurationError);
    expect(() => getEffectiveSandboxInstagramUsername()).toThrow(
      /Instagram sandbox is not configured for production yet/,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run src/config/__tests__/env-profiles.test.ts
```

Expected: FAIL — `'getEffectiveSandboxInstagramUsername' is not exported`.

- [ ] **Step 4: Implement the helper + fix the raw throw**

In `src/config/env-profiles.ts`:

First, find the raw throw at line 125 (it'll look approximately like):

```typescript
throw new Error(`Unknown HOOKMYAPP_ENV "${env}". Expected one of: ${VALID_ENV_NAMES.join(', ')}`);
```

Replace with:

```typescript
throw new ConfigurationError(
  `Unknown HOOKMYAPP_ENV "${env}". Expected one of: ${VALID_ENV_NAMES.join(', ')}`,
  'INVALID_ENV',
);
```

Add the import at the top of the file if not present:

```typescript
import { ConfigurationError } from '../output/error.js';
```

Then immediately after the closing brace of `getEffectiveSandboxWhatsAppNumber` (around line 167), insert:

```typescript
/**
 * Resolve the sandbox Instagram handle used by `sandbox start --type=instagram`
 * for the bind-code IG deep link. Per-env, mirrors WA's pattern:
 *
 *   local + staging → @hookmyappsandboxstaging
 *   production      → not yet provisioned — throws ConfigurationError
 *
 * Per project memory reference_sandbox_ig_account: production IG sandbox
 * handle is genuinely TBD. Shipping a placeholder would silently produce a
 * broken ig.me deep link that consumes a bind code that never gets matched.
 * Fail fast at the env-profile boundary.
 */
export function getEffectiveSandboxInstagramUsername(): string {
  const env = resolveEnv();
  if (env === 'production') {
    throw new ConfigurationError(
      'Instagram sandbox is not configured for production yet. Use --type=whatsapp, or switch to staging/local.',
      'IG_SANDBOX_NOT_CONFIGURED_PROD',
    );
  }
  return '@hookmyappsandboxstaging';
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm vitest run src/config/__tests__/env-profiles.test.ts
```

Expected: PASS — three tests green.

- [ ] **Step 6: Commit**

```bash
git add src/config/env-profiles.ts src/config/__tests__/env-profiles.test.ts
git commit -m "feat(env-profiles): getEffectiveSandboxInstagramUsername + ConfigurationError for invalid env (D10)"
```

---

## Task 3: Shared helpers — `sessionIdentifier`, `sessionLabel`, `buildSandboxSendRequest`

**Files:**
- Create: `src/commands/sandbox/helpers.ts`
- Create: `src/commands/sandbox/__tests__/helpers.test.ts`

**Why:** Three shared helpers concentrate every channel narrow into one place per concept (spec D8). The picker, status table, error messages, and `runSandboxSend` all flow through these instead of inlining `switch (session.type)`. Adding Messenger later = three new branches here + one in the parser; every consumer compiles unchanged.

- [ ] **Step 1: Create the `src/commands/sandbox/` directory**

```bash
cd /Users/ordvir/COD/cli
mkdir -p src/commands/sandbox/__tests__
```

- [ ] **Step 2: Write the failing test**

Create `src/commands/sandbox/__tests__/helpers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sessionIdentifier,
  sessionLabel,
  buildSandboxSendRequest,
} from '../helpers.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa_xxx',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

const igWithUsername: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig_xxx',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

const igWithoutUsername: InstagramSandboxSession = {
  ...igWithUsername,
  id: 'ssn_IG000002',
  instagramSenderUsername: null,
};

describe('sessionIdentifier', () => {
  it('renders +<phone> for WhatsApp', () => {
    expect(sessionIdentifier(wa)).toBe('+15551234567');
  });

  it('renders @<username> for Instagram when username is present', () => {
    expect(sessionIdentifier(igWithUsername)).toBe('@ordvir');
  });

  it('falls back to IGSID when Instagram username is null', () => {
    expect(sessionIdentifier(igWithoutUsername)).toBe('8745912038476523');
  });
});

describe('sessionLabel', () => {
  it('formats WhatsApp', () => {
    expect(sessionLabel(wa)).toBe('WhatsApp +15551234567 (active)');
  });

  it('formats Instagram with username', () => {
    expect(sessionLabel(igWithUsername)).toBe('Instagram @ordvir (active)');
  });

  it('formats Instagram without username (IGSID fallback)', () => {
    expect(sessionLabel(igWithoutUsername)).toBe(
      'Instagram 8745912038476523 (active)',
    );
  });
});

describe('buildSandboxSendRequest', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('builds the WhatsApp send URL using sandboxPhoneNumberId (not the tester phone)', () => {
    const { url } = buildSandboxSendRequest(wa, 'hi');
    expect(url).toBe('https://proxy.test/v24.0/1080996501762047/messages');
  });

  it('builds the WhatsApp send body in the WA shape', () => {
    const { body } = buildSandboxSendRequest(wa, 'hi');
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi' },
    });
  });

  it('builds the Instagram send URL using instagramAccountId and v25.0', () => {
    const { url } = buildSandboxSendRequest(igWithUsername, 'hi');
    expect(url).toBe('https://proxy.test/v25.0/17841478719287768/messages');
  });

  it('builds the Instagram send body in the IG shape', () => {
    const { body } = buildSandboxSendRequest(igWithUsername, 'hello there');
    expect(body).toEqual({
      recipient: { id: '8745912038476523' },
      message: { text: 'hello there' },
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm vitest run src/commands/sandbox/__tests__/helpers.test.ts
```

Expected: FAIL — `Cannot find module '../helpers.js'`.

- [ ] **Step 4: Implement the helpers**

Create `src/commands/sandbox/helpers.ts`:

```typescript
// Shared sandbox-session helpers. The first two are pure (no side effects).
// buildSandboxSendRequest is explicitly NOT pure: it reads
// getEffectiveSandboxProxyUrl() for the proxy host. We name it Build* rather
// than calling it Target/Get to acknowledge the env-var read; see spec D8.

import { getEffectiveSandboxProxyUrl } from '../../config/env-profiles.js';
import {
  assertNever,
  INSTAGRAM_GRAPH_VERSION,
  type SandboxSession,
} from '../../api/sandbox-session.js';

/**
 * Display identifier for a session. WhatsApp: +<phone>. Instagram: @<handle>,
 * falling back to IGSID when the username is null (backend backfills async).
 */
export function sessionIdentifier(s: SandboxSession): string {
  switch (s.type) {
    case 'whatsapp':
      return `+${s.whatsappPhone.replace(/^\+/, '')}`;
    case 'instagram':
      return s.instagramSenderUsername
        ? `@${s.instagramSenderUsername}`
        : s.instagramSenderId;
    default:
      return assertNever(s, 'sessionIdentifier');
  }
}

/**
 * Picker-row label: "WhatsApp +15551234567 (active)" / "Instagram @ordvir (active)".
 * Used by the unified picker's interactive select prompt + status table.
 */
export function sessionLabel(s: SandboxSession): string {
  switch (s.type) {
    case 'whatsapp':
      return `WhatsApp ${sessionIdentifier(s)} (${s.status})`;
    case 'instagram':
      return `Instagram ${sessionIdentifier(s)} (${s.status})`;
    default:
      return assertNever(s, 'sessionLabel');
  }
}

/**
 * Build the HTTP send request (URL + body) for `sandbox send`. Reads the
 * effective proxy URL via getEffectiveSandboxProxyUrl() — env-var lookup —
 * which is why this helper is not pure.
 *
 * WA:  POST {proxy}/{whatsappApiVersion}/{sandboxPhoneNumberId}/messages
 *      with { messaging_product:'whatsapp', to, type:'text', text:{body} }
 * IG:  POST {proxy}/{INSTAGRAM_GRAPH_VERSION}/{instagramAccountId}/messages
 *      with { recipient:{id:instagramSenderId}, message:{text} }
 */
export function buildSandboxSendRequest(
  s: SandboxSession,
  message: string,
): { url: string; body: unknown } {
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  switch (s.type) {
    case 'whatsapp': {
      const to = s.whatsappPhone.replace(/^\+/, '');
      return {
        url: `${proxyBase}/${s.whatsappApiVersion}/${s.sandboxPhoneNumberId}/messages`,
        body: {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message },
        },
      };
    }
    case 'instagram':
      return {
        url: `${proxyBase}/${INSTAGRAM_GRAPH_VERSION}/${s.instagramAccountId}/messages`,
        body: {
          recipient: { id: s.instagramSenderId },
          message: { text: message },
        },
      };
    default:
      return assertNever(s, 'buildSandboxSendRequest');
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm vitest run src/commands/sandbox/__tests__/helpers.test.ts
```

Expected: PASS — all 9 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/sandbox/helpers.ts src/commands/sandbox/__tests__/helpers.test.ts
git commit -m "feat(sandbox): shared helpers (sessionIdentifier / Label / buildSandboxSendRequest)"
```

---

## Task 4: Unified picker

**Files:**
- Create: `src/commands/sandbox/picker.ts`
- Create: `src/commands/sandbox/__tests__/picker.test.ts`

**Why:** One picker function replaces today's `pickSessionByPhone` (env/send) + the local `pickSendSession` (in sandbox.ts) + drives the same logic in `sandbox-listen/picker.ts` (Task 12 generalizes the listen picker to call this). Accepts `--phone | --username | --session`; validates at most one selector flag; falls back to interactive `select` in TTY mode, exits 2 in non-TTY mode with no flag.

- [ ] **Step 1: Write the failing test**

Create `src/commands/sandbox/__tests__/picker.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { pickSession } from '../picker.js';
import { ValidationError, CliError } from '../../../output/error.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

const igNoUsername: InstagramSandboxSession = {
  ...ig,
  id: 'ssn_IG000002',
  instagramSenderUsername: null,
};

describe('pickSession — flag conflicts (D3, error E4/E5)', () => {
  it('throws ValidationError when both --phone and --username are provided', async () => {
    await expect(
      pickSession({
        sessions: [wa, ig],
        phoneFlag: '+15551234567',
        usernameFlag: '@ordvir',
        isHuman: true,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when both --phone and --session are provided', async () => {
    await expect(
      pickSession({
        sessions: [wa],
        phoneFlag: '+15551234567',
        sessionFlag: 'ssn_WA000001',
        isHuman: true,
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });
});

describe('pickSession — exact match by flag', () => {
  it('--phone matches a WA session', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      phoneFlag: '+15551234567',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_WA000001');
  });

  it('--phone strips leading + for normalization', async () => {
    const out = await pickSession({
      sessions: [wa],
      phoneFlag: '15551234567',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_WA000001');
  });

  it('--username matches an IG session and strips leading @', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      usernameFlag: 'ordvir',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });

  it('--username @<handle> works with the leading @', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      usernameFlag: '@ordvir',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });

  it('--session matches by publicId', async () => {
    const out = await pickSession({
      sessions: [wa, ig],
      sessionFlag: 'ssn_IG000001',
      isHuman: true,
    });
    expect(out.id).toBe('ssn_IG000001');
  });
});

describe('pickSession — mismatch paths (E6, E7)', () => {
  it('throws SESSION_MISMATCH exit 2 on --phone with no match', async () => {
    try {
      await pickSession({
        sessions: [wa, ig],
        phoneFlag: '+99999999999',
        isHuman: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('throws SESSION_MISMATCH on --session with no match', async () => {
    try {
      await pickSession({
        sessions: [wa, ig],
        sessionFlag: 'ssn_MISSING1',
        isHuman: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('emits null-backfill-aware message when --username has no match because all IG candidates have null username', async () => {
    try {
      await pickSession({
        sessions: [wa, igNoUsername],
        usernameFlag: '@ordvir',
        isHuman: true,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as Error).message).toMatch(/still resolving from Meta/);
      expect((err as Error).message).toMatch(/--session/);
    }
  });
});

describe('pickSession — zero and one session', () => {
  it('throws CliError NO_ACTIVE_SESSIONS exit 2 when sessions array is empty', async () => {
    try {
      await pickSession({ sessions: [], isHuman: true });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('NO_ACTIVE_SESSIONS');
      expect((err as CliError).exitCode).toBe(2);
    }
  });

  it('silently auto-picks the single session when no flag is given and alwaysShowPicker is false', async () => {
    const out = await pickSession({
      sessions: [wa],
      isHuman: true,
    });
    expect(out.id).toBe('ssn_WA000001');
  });
});

describe('pickSession — non-TTY mode', () => {
  it('throws SESSION_MISMATCH exit 2 when multiple sessions exist + no flag + not human', async () => {
    try {
      await pickSession({
        sessions: [wa, ig],
        isHuman: false,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect((err as CliError).code).toBe('SESSION_MISMATCH');
      expect((err as CliError).exitCode).toBe(2);
      expect((err as Error).message).toMatch(/Multiple active sessions/);
    }
  });
});

describe('pickSession — alwaysShowPicker (sandbox send)', () => {
  it('shows interactive picker even with a single session when alwaysShowPicker is true', async () => {
    // The top-of-file static import has already cached pickSession.js. To
    // swap @inquirer/prompts for the duration of this one test, reset the
    // module registry, install the doMock, and dynamically re-import.
    const selectMock = vi.fn().mockResolvedValue(wa);
    vi.resetModules();
    vi.doMock('@inquirer/prompts', () => ({ select: selectMock }));
    const { pickSession: piPicker } = await import('../picker.js');

    const out = await piPicker({
      sessions: [wa],
      isHuman: true,
      alwaysShowPicker: true,
    });
    expect(out.id).toBe('ssn_WA000001');
    expect(selectMock).toHaveBeenCalled();
    vi.doUnmock('@inquirer/prompts');
    vi.resetModules();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/commands/sandbox/__tests__/picker.test.ts
```

Expected: FAIL — `Cannot find module '../picker.js'`.

- [ ] **Step 3: Implement the picker**

Create `src/commands/sandbox/picker.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/commands/sandbox/__tests__/picker.test.ts
```

Expected: PASS — all ~12 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox/picker.ts src/commands/sandbox/__tests__/picker.test.ts
git commit -m "feat(sandbox): unified pickSession with --phone/--username/--session (D3)"
```

---

## Task 5: `sandbox env` subcommand with WA + IG branches

**Files:**
- Create: `src/commands/sandbox/env.ts`
- Create: `src/commands/sandbox/__tests__/env.test.ts`

**Why:** First command-runner using the new building blocks. WA branch is a regression of today's behavior; IG branch emits the new 5-line block from D2. The 5-line shape: `VERIFY_TOKEN`, `PORT`, `<CHANNEL>_API_URL`, `<CHANNEL>_ACCESS_TOKEN`, `<CHANNEL>_<key>` (`WHATSAPP_PHONE_NUMBER_ID` for WA — note the spec D4 quirk this perpetuates intentionally — vs `INSTAGRAM_ACCOUNT_ID` for IG).

- [ ] **Step 1: Write the failing test**

Create `src/commands/sandbox/__tests__/env.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxEnv, buildEnvBlock } from '../env.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa_xxx',
  hmacSecret: 'HMAC_wa_yyy',
  status: 'active',
  origin: 'manual',
};

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig_xxx',
  hmacSecret: 'HMAC_ig_yyy',
  status: 'active',
  origin: 'demo_handoff',
};

describe('buildEnvBlock — WhatsApp regression', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('emits the existing 5-line WA block', () => {
    const out = buildEnvBlock(wa);
    expect(out).toBe(
      [
        'VERIFY_TOKEN=HMAC_wa_yyy',
        'PORT=3000',
        'WHATSAPP_API_URL=https://proxy.test/v24.0',
        'WHATSAPP_ACCESS_TOKEN=ACT_wa_xxx',
        'WHATSAPP_PHONE_NUMBER_ID=15551234567',
        '',
      ].join('\n'),
    );
  });
});

describe('buildEnvBlock — Instagram (D2)', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('emits the 5-line IG block with INSTAGRAM_* vars and v25.0 URL', () => {
    const out = buildEnvBlock(ig);
    expect(out).toBe(
      [
        'VERIFY_TOKEN=HMAC_ig_yyy',
        'PORT=3000',
        'INSTAGRAM_API_URL=https://proxy.test/v25.0',
        'INSTAGRAM_ACCESS_TOKEN=ACT_ig_xxx',
        'INSTAGRAM_ACCOUNT_ID=17841478719287768',
        '',
      ].join('\n'),
    );
  });
});

describe('runSandboxEnv — happy path', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('prints WA block to stdout when --write is not set', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxEnv({});
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('WHATSAPP_API_URL='));
    writeSpy.mockRestore();
  });

  it('prints IG block when the only session is IG', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSandboxEnv({});
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('INSTAGRAM_API_URL='));
    writeSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/commands/sandbox/__tests__/env.test.ts
```

Expected: FAIL — `Cannot find module '../env.js'`.

- [ ] **Step 3: Implement `sandbox env`**

Create `src/commands/sandbox/env.ts`:

```typescript
// `hookmyapp sandbox env` — emit the canonical .env block for a sandbox session.
// Pipe-safe by default (writes to stdout); --write [path] writes to disk with
// a clobber prompt (or --force).
//
// Per D2: WA block is 5 lines with WHATSAPP_* prefix (unchanged — including
// the WA quirk where WHATSAPP_PHONE_NUMBER_ID carries the tester's phone, per
// spec D4). IG block is 5 lines with INSTAGRAM_* prefix:
//   VERIFY_TOKEN, PORT, INSTAGRAM_API_URL, INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID.

import * as fs from 'node:fs';
import { confirm } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  assertNever,
  INSTAGRAM_GRAPH_VERSION,
  parseSandboxSessions,
  type SandboxSession,
} from '../../api/sandbox-session.js';
import {
  getEffectiveSandboxProxyUrl,
} from '../../config/env-profiles.js';
import { ValidationError } from '../../output/error.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { pickSession } from './picker.js';

export function buildEnvBlock(session: SandboxSession): string {
  const proxyBase = getEffectiveSandboxProxyUrl().replace(/\/$/, '');
  switch (session.type) {
    case 'whatsapp':
      return [
        `VERIFY_TOKEN=${session.hmacSecret}`,
        `PORT=3000`,
        `WHATSAPP_API_URL=${proxyBase}/${session.whatsappApiVersion}`,
        `WHATSAPP_ACCESS_TOKEN=${session.accessToken}`,
        `WHATSAPP_PHONE_NUMBER_ID=${session.whatsappPhone}`,
        '',
      ].join('\n');
    case 'instagram':
      return [
        `VERIFY_TOKEN=${session.hmacSecret}`,
        `PORT=3000`,
        `INSTAGRAM_API_URL=${proxyBase}/${INSTAGRAM_GRAPH_VERSION}`,
        `INSTAGRAM_ACCESS_TOKEN=${session.accessToken}`,
        `INSTAGRAM_ACCOUNT_ID=${session.instagramAccountId}`,
        '',
      ].join('\n');
    default:
      return assertNever(session, 'buildEnvBlock');
  }
}

export async function runSandboxEnv(opts: {
  phone?: string;
  username?: string;
  session?: string;
  write?: string | boolean;
  force?: boolean;
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
  });

  const content = buildEnvBlock(session);

  if (opts.write === undefined) {
    process.stdout.write(content);
    return;
  }

  const target = typeof opts.write === 'string' ? opts.write : '.env';
  if (fs.existsSync(target) && !opts.force) {
    if (opts.json) {
      throw new ValidationError(
        `${target} exists — pass --force to overwrite (or --write=<other-path>)`,
      );
    }
    const ok = await confirm({
      message: `${target} already exists. Overwrite?`,
      default: false,
    });
    if (!ok) return;
  }
  fs.writeFileSync(target, content);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/commands/sandbox/__tests__/env.test.ts
```

Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox/env.ts src/commands/sandbox/__tests__/env.test.ts
git commit -m "feat(sandbox): env subcommand with INSTAGRAM_* branch (D2)"
```

---

## Task 6: `sandbox send` subcommand with IG body shape

**Files:**
- Create: `src/commands/sandbox/send.ts`
- Create: `src/commands/sandbox/__tests__/send.test.ts`

**Why:** Routes the send request through `buildSandboxSendRequest`. WA path matches today's body shape. IG path posts the new IG body to `/v25.0/{instagramAccountId}/messages` per the sandbox-proxy contract. The `body.message_id` flat-field fallback handles IG's response shape per spec correction C3.

- [ ] **Step 1: Write the failing test**

Create `src/commands/sandbox/__tests__/send.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxSend } from '../send.js';
import { ApiError, SessionWindowError } from '../../../output/error.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxSend — WhatsApp', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
    vi.restoreAllMocks();
  });

  it('posts to the WA endpoint with the WA body shape', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 }),
    );

    await runSandboxSend({ phone: '+15551234567', message: 'hi' });

    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://proxy.test/v24.0/1080996501762047/messages');
    expect(JSON.parse(String(calledInit?.body))).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi' },
    });
  });
});

describe('runSandboxSend — Instagram', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
    vi.mocked(apiClient).mockReset();
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
    vi.restoreAllMocks();
  });

  it('posts to the IG endpoint with the IG body shape', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ recipient_id: '8745912038476523', message_id: 'mid.IGSTANDARD_xxx' }),
        { status: 201 },
      ),
    );

    await runSandboxSend({ username: '@ordvir', message: 'hello' });

    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('https://proxy.test/v25.0/17841478719287768/messages');
    expect(JSON.parse(String(calledInit?.body))).toEqual({
      recipient: { id: '8745912038476523' },
      message: { text: 'hello' },
    });
  });

  it('extracts message_id from the flat IG response shape', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ recipient_id: '8745912038476523', message_id: 'mid.IGSTANDARD_xxx' }),
        { status: 201 },
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runSandboxSend({ username: '@ordvir', message: 'hi' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('mid.IGSTANDARD_xxx'));
  });

  it('surfaces SESSION_WINDOW_CLOSED 403 from sandbox-proxy verbatim (E8)', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([ig]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'SESSION_WINDOW_CLOSED',
          message: 'Reply window is closed. Customer must message you again first.',
        }),
        { status: 403 },
      ),
    );

    // Single run; both assertions share the same caught error so the one-shot
    // mocks aren't consumed twice.
    let caught: unknown;
    try {
      await runSandboxSend({ username: '@ordvir', message: 'late reply' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionWindowError);
    expect((caught as Error).message).toMatch(/Reply window is closed/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/commands/sandbox/__tests__/send.test.ts
```

Expected: FAIL — `Cannot find module '../send.js'`.

- [ ] **Step 3: Implement `sandbox send`**

Create `src/commands/sandbox/send.ts`:

```typescript
// `hookmyapp sandbox send` — send a one-shot test message via the shared
// sandbox-proxy. WA: text message to the test phone. IG: text message to
// the IGSID that originated the session. Both flow through
// buildSandboxSendRequest which encapsulates the URL + body shape per channel.
//
// SESSION_WINDOW_CLOSED 403 from sandbox-proxy is reflected verbatim (the
// proxy's body.message wins; falls back to the hardcoded WA-flavored string
// if absent). Per spec E8.

import { input } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
} from '../../api/sandbox-session.js';
import {
  ApiError,
  SessionWindowError,
} from '../../output/error.js';
import { c, icon } from '../../output/color.js';
import { output } from '../../output/format.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { buildSandboxSendRequest, sessionIdentifier } from './helpers.js';
import { pickSession } from './picker.js';

export async function runSandboxSend(opts: {
  phone?: string;
  username?: string;
  session?: string;
  message?: string;
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

  const message =
    opts.message ??
    (await input({
      message: 'Message:',
      validate: (v: string) => (v.length > 0 ? true : 'Message cannot be empty'),
    }));

  const { url, body } = buildSandboxSendRequest(session, message);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resBody: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 403 && resBody?.code === 'SESSION_WINDOW_CLOSED') {
      throw new SessionWindowError(
        resBody.message ??
          'Recipient has not sent an inbound message in the last 24 hours.',
      );
    }
    const msg: string =
      resBody?.error?.message ?? resBody?.message ?? `Send failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }

  if (opts.json) {
    output(resBody, { json: true });
    return;
  }

  const msgId: string =
    resBody?.messages?.[0]?.id ?? resBody?.message_id ?? '?';
  console.log(
    `${c.success(icon.success)} Message sent to ${sessionIdentifier(session)} (id: ${msgId})`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/commands/sandbox/__tests__/send.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox/send.ts src/commands/sandbox/__tests__/send.test.ts
git commit -m "feat(sandbox): send subcommand with IG body + message_id extraction (A3, E8)"
```

---

## Task 7: `sandbox start` subcommand with `--type` chooser

**Files:**
- Create: `src/commands/sandbox/start.ts`
- Create: `src/commands/sandbox/__tests__/start.test.ts`

**Why:** Adds the `--type=whatsapp|instagram` chooser per spec D1. WA path is the existing flow unchanged. IG path renders the `ig.me/m/{handle}?text={code}` QR + deep link (handle WITHOUT `@`, code `encodeURIComponent`-d). Production env throws `ConfigurationError` per D10. `--json` without `--type` throws `ValidationError` exit 2 per E3.

- [ ] **Step 1: Write the failing test**

Create `src/commands/sandbox/__tests__/start.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Single combined mock — vi.mock collapses to the LAST declaration for a given
// path, so splitting apiClient + getBindCode across two vi.mock('../../../api/client.js')
// blocks would lose `apiClient` entirely. Define both in one block.
vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
  getBindCode: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { ValidationError, ConfigurationError } from '../../../output/error.js';
import { runSandboxStart } from '../start.js';

describe('runSandboxStart — flag validation', () => {
  it('throws ValidationError exit 2 in --json mode without --type (E3)', async () => {
    await expect(runSandboxStart({ json: true })).rejects.toThrow(ValidationError);
    await expect(runSandboxStart({ json: true })).rejects.toThrow(/--type is required/);
  });

  it('throws ValidationError on invalid --type value (Commander does not enforce enum)', async () => {
    await expect(
      runSandboxStart({ type: 'messenger' as never, json: true }),
    ).rejects.toThrow(ValidationError);
    await expect(
      runSandboxStart({ type: 'messenger' as never, json: true }),
    ).rejects.toThrow(/Invalid --type value/);
  });
});

describe('runSandboxStart — Instagram in production (E2/D10)', () => {
  const originalEnv = process.env.HOOKMYAPP_ENV;
  beforeEach(() => {
    process.env.HOOKMYAPP_ENV = 'production';
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = originalEnv;
  });

  it('throws ConfigurationError when --type=instagram is used in production', async () => {
    await expect(
      runSandboxStart({ type: 'instagram', json: true }),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      runSandboxStart({ type: 'instagram', json: true }),
    ).rejects.toThrow(/Instagram sandbox is not configured for production yet/);
  });
});

describe('runSandboxStart — Instagram in staging', () => {
  const originalEnv = process.env.HOOKMYAPP_ENV;
  beforeEach(() => {
    process.env.HOOKMYAPP_ENV = 'staging';
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = originalEnv;
  });

  it('builds the correct ig.me deep link (no @ in path, code encoded)', async () => {
    const { buildInstagramDeepLink } = await import('../start.js');
    const url = buildInstagramDeepLink('@hookmyappsandboxstaging', 'hmp3gj54');
    expect(url).toBe('https://ig.me/m/hookmyappsandboxstaging?text=hmp3gj54');
  });

  it('URL-encodes the bind code', async () => {
    const { buildInstagramDeepLink } = await import('../start.js');
    const url = buildInstagramDeepLink('@hookmyappsandboxstaging', 'a b+c');
    expect(url).toBe('https://ig.me/m/hookmyappsandboxstaging?text=a%20b%2Bc');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/commands/sandbox/__tests__/start.test.ts
```

Expected: FAIL — `Cannot find module '../start.js'`.

- [ ] **Step 3: Implement `sandbox start`**

Create `src/commands/sandbox/start.ts`:

```typescript
// `hookmyapp sandbox start` — bind-code flow with --type chooser (D1).
// WA path: shows the existing wa.me QR + deep link, polls bind code,
// announces the consumed session. IG path: shows the ig.me/m/{handle}
// QR + deep link (handle stripped of @, code URL-encoded), same polling
// loop. Production with --type=instagram throws ConfigurationError per D10.

import { select } from '@inquirer/prompts';
import qrcode from 'qrcode-terminal';
import ora from 'ora';
import pc from 'picocolors';
import { apiClient, getBindCode } from '../../api/client.js';
import {
  AuthError,
  ConfigurationError,
  ConflictError,
  ValidationError,
} from '../../output/error.js';
import { c } from '../../output/color.js';
import {
  getEffectiveSandboxInstagramUsername,
  getEffectiveSandboxWhatsAppNumber,
} from '../../config/env-profiles.js';
import { parseSandboxSession } from '../../api/sandbox-session.js';
import { getDefaultWorkspaceId } from '../_helpers.js';

export function buildInstagramDeepLink(handle: string, code: string): string {
  const stripped = handle.replace(/^@/, '');
  return `https://ig.me/m/${stripped}?text=${encodeURIComponent(code)}`;
}

function buildWhatsAppDeepLink(number: string, code: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(code)}`;
}

export async function runSandboxStart(opts: {
  type?: 'whatsapp' | 'instagram';
  workspace?: string;
  listen?: boolean;
  json?: boolean;
}): Promise<void> {
  const isTty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const isHuman = !opts.json && isTty;

  // Commander's .option() doesn't enforce enum values — explicit validation
  // is required so `--type=foo` doesn't fall through into the IG branch by
  // virtue of "not whatsapp" later in the if-else.
  if (
    opts.type !== undefined &&
    opts.type !== 'whatsapp' &&
    opts.type !== 'instagram'
  ) {
    throw new ValidationError(
      `Invalid --type value: ${String(opts.type)}. Must be 'whatsapp' or 'instagram'.`,
      'INVALID_TYPE',
    );
  }

  let channelType: 'whatsapp' | 'instagram';
  if (opts.type) {
    channelType = opts.type;
  } else if (opts.json) {
    throw new ValidationError(
      '--type is required in --json mode (use --type=whatsapp or --type=instagram).',
      'TYPE_REQUIRED_IN_JSON',
    );
  } else if (isHuman) {
    channelType = await select<'whatsapp' | 'instagram'>({
      message: 'Which channel?',
      choices: [
        { name: 'WhatsApp', value: 'whatsapp' },
        { name: 'Instagram', value: 'instagram' },
      ],
    });
  } else {
    // Non-TTY, no --type, no --json: refuse rather than guess.
    throw new ValidationError(
      '--type is required in non-interactive mode.',
      'TYPE_REQUIRED_IN_JSON',
    );
  }

  // IG path fails fast in production before any backend call.
  if (channelType === 'instagram') {
    // Throws ConfigurationError in production (D10); returns the staging/local handle otherwise.
    getEffectiveSandboxInstagramUsername();
  }

  const workspaceId = await getDefaultWorkspaceId();
  const bindRes = await getBindCode(workspaceId);
  const bindCode = bindRes.code;

  let deepLink: string;
  let headerHint: string;
  if (channelType === 'whatsapp') {
    const waNumber = getEffectiveSandboxWhatsAppNumber();
    deepLink = buildWhatsAppDeepLink(waNumber, bindCode);
    headerHint = 'Send this code to the sandbox WhatsApp number from the phone you want to bind.';
  } else {
    const igHandle = getEffectiveSandboxInstagramUsername();
    deepLink = buildInstagramDeepLink(igHandle, bindCode);
    headerHint = `DM the sandbox Instagram account (${igHandle}) from the account you want to bind.`;
  }

  console.log();
  console.log(isTty ? pc.bold('Start a sandbox testing session') : 'Start a sandbox testing session');
  console.log(isTty ? c.dim(headerHint) : headerHint);
  console.log();
  console.log(isTty ? `  ${pc.bold(pc.cyan(bindCode))}` : `  ${bindCode}`);
  console.log();
  if (isTty) {
    qrcode.generate(deepLink, { small: true });
    console.log();
  }
  console.log(isTty ? c.dim(`Or open: ${deepLink}`) : `Or open: ${deepLink}`);
  console.log();

  // Poll loop with spinner + Ctrl+C trap + 5-minute soft warning.
  const waitingMsg =
    channelType === 'whatsapp'
      ? 'Waiting for your WhatsApp message…'
      : 'Waiting for your Instagram DM…';
  const spinner = isTty ? ora(waitingMsg) : null;
  spinner?.start();

  const onSigint = (): void => {
    spinner?.stop();
    console.log();
    console.log(
      isTty
        ? c.dim('Cancelled. Your bind code is still valid — run `hookmyapp sandbox start` again to resume.')
        : 'Cancelled. Your bind code is still valid — run `hookmyapp sandbox start` again to resume.',
    );
    process.exit(0);
  };
  process.once('SIGINT', onSigint);

  const started = Date.now();
  let warned = false;
  try {
    while (true) {
      try {
        const latest = await getBindCode(workspaceId);
        if (latest.consumedSessionId) {
          const dto = await apiClient(
            `/sandbox/sessions/${latest.consumedSessionId}`,
            { workspaceId },
          );
          const session = parseSandboxSession(dto);
          const ident =
            session.type === 'whatsapp'
              ? `+${session.whatsappPhone}`
              : session.type === 'instagram' && session.instagramSenderUsername
                ? `@${session.instagramSenderUsername}`
                : (session as { instagramSenderId?: string }).instagramSenderId ?? '(unknown)';
          spinner?.succeed(`Session created. ${ident}. Token: ${session.accessToken}`);
          if (!isTty) {
            console.log(`Session created. ${ident}. Token: ${session.accessToken}`);
          }
          if (opts.listen) {
            // In-process chain into `sandbox listen` (matches existing precedent
            // for the WA --listen flag). Task 12 will wire this through the new
            // unified picker contract once the listen integration lands.
            const { runSandboxListenFlow } = await import('../sandbox-listen/index.js');
            await runSandboxListenFlow(
              {
                id: session.id,
                workspaceId,
                phone: session.type === 'whatsapp' ? session.whatsappPhone : null,
                status: session.status,
                lastHeartbeatAt: session.lastHeartbeatAt ?? null,
              } as any,
              {},
            );
          }
          return;
        }
      } catch (err) {
        if (err instanceof ConflictError) {
          spinner?.fail('This account is already bound to another workspace. Remove the existing binding first.');
          throw err;
        }
        if (err instanceof AuthError) {
          spinner?.fail("You're not logged in. Run `hookmyapp login` first.");
          throw err;
        }
        // Retry only on known-transient failures (network + 5xx). Anything
        // else — parser failures (UnexpectedError/MALFORMED_SANDBOX_SESSION),
        // 4xx, programming errors — must NOT be swallowed silently in the
        // poll loop; that would hide real bugs forever behind the spinner.
        const { NetworkError, ApiError } = await import('../../output/error.js');
        const isTransient =
          err instanceof NetworkError ||
          (err instanceof ApiError && err.statusCode !== undefined && err.statusCode >= 500);
        if (!isTransient) {
          spinner?.fail(
            err instanceof Error ? err.message : 'Unexpected error while polling for bind code',
          );
          throw err;
        }
        // Transient — retry next tick.
      }
      if (!warned && Date.now() - started > 5 * 60 * 1000) {
        spinner?.warn('Still waiting. Press Ctrl+C to cancel, or leave this running.');
        spinner?.start(waitingMsg);
        warned = true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/commands/sandbox/__tests__/start.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox/start.ts src/commands/sandbox/__tests__/start.test.ts
git commit -m "feat(sandbox): start --type=whatsapp|instagram with ig.me QR + prod fail-fast (D1, D10)"
```

---

## Task 8: `sandbox status` subcommand with Type column

**Files:**
- Create: `src/commands/sandbox/status.ts`

**Why:** Display layer. Renders `Type | Identifier | Status | Listener` columns via `sessionIdentifier()`. The Listener column stays for parity with `sandbox-listen` heartbeat semantics; renders empty when `lastHeartbeatAt` is null. No new test file — covered by existing `sandbox-listen-banner.test.ts` patterns when Task 12 generalizes them.

- [ ] **Step 1: Write the implementation**

Create `src/commands/sandbox/status.ts`:

```typescript
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
```

- [ ] **Step 2: Verify the new module compiles**

```bash
cd /Users/ordvir/COD/cli
pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: zero errors related to `status.ts`. (You may see errors from `index.ts` still pointing at the old `sandbox.ts` — that's Task 13.)

- [ ] **Step 3: Commit**

```bash
git add src/commands/sandbox/status.ts
git commit -m "feat(sandbox): status subcommand with Type|Identifier|Status|Listener columns (A4)"
```

---

## Task 9: `sandbox stop` subcommand

**Files:**
- Create: `src/commands/sandbox/stop.ts`

**Why:** Picker generalization with no IG-specific behavior. Today's `runSandboxStop` (inside `sandbox.ts`) picks a session by phone, confirms, and deletes. The new version routes through `pickSession` with all three flags.

- [ ] **Step 1: Write the implementation**

Create `src/commands/sandbox/stop.ts`:

```typescript
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
```

- [ ] **Step 2: Verify the new module compiles**

```bash
pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: zero errors related to `stop.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/commands/sandbox/stop.ts
git commit -m "feat(sandbox): stop subcommand using unified picker"
```

---

## Task 10: `sandbox webhook show/set/clear` subcommand

**Files:**
- Create: `src/commands/sandbox/webhook.ts`
- Create: `src/commands/sandbox/__tests__/webhook.test.ts`

**Why:** Migrates the three webhook subcommands from positional `[phone]` to flag-based selectors per spec D3/D12. Positional `[phone]` keeps working in 0.12.2 with a stderr deprecation warning. Positional + flag → `CONFLICTING_SELECTORS` exit 2 per E5.

- [ ] **Step 1: Write the failing test**

Create `src/commands/sandbox/__tests__/webhook.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
vi.mock('../../_helpers.js', () => ({
  getDefaultWorkspaceId: vi.fn().mockResolvedValue('ws_TEST0001'),
}));

import { apiClient } from '../../../api/client.js';
import { runSandboxWebhookSet } from '../webhook.js';
import { ValidationError } from '../../../output/error.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa',
  hmacSecret: 'HMAC_wa',
  status: 'active',
  origin: 'manual',
};

const ig: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  instagramSenderId: '8745912038476523',
  instagramAccountId: '17841478719287768',
  instagramSenderUsername: 'ordvir',
  accessToken: 'ACT_ig',
  hmacSecret: 'HMAC_ig',
  status: 'active',
  origin: 'demo_handoff',
};

describe('runSandboxWebhookSet — positional + flag conflict (E5)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('throws CONFLICTING_SELECTORS when positional + --username are both provided', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa, ig]);
    await expect(
      runSandboxWebhookSet({
        positionalPhone: '+15551234567',
        username: '@ordvir',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws CONFLICTING_SELECTORS when positional + --session are both provided', async () => {
    vi.mocked(apiClient).mockResolvedValueOnce([wa]);
    await expect(
      runSandboxWebhookSet({
        positionalPhone: '+15551234567',
        session: 'ssn_WA000001',
        url: 'https://my.example/hook',
      }),
    ).rejects.toThrow(/Conflicting selectors/);
  });
});

describe('runSandboxWebhookSet — positional alone emits deprecation warning (D12)', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('writes a deprecation warning to stderr and proceeds', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa])
      .mockResolvedValueOnce(undefined);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runSandboxWebhookSet({
      positionalPhone: '+15551234567',
      url: 'https://my.example/hook',
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[deprecated]'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--phone'));
    errSpy.mockRestore();
  });
});

describe('runSandboxWebhookSet — --username selects IG session', () => {
  beforeEach(() => {
    vi.mocked(apiClient).mockReset();
  });

  it('selects the IG session and sends the PUT', async () => {
    vi.mocked(apiClient)
      .mockResolvedValueOnce([wa, ig])
      .mockResolvedValueOnce(undefined);
    await runSandboxWebhookSet({
      username: '@ordvir',
      url: 'https://my.example/hook',
    });
    // Second apiClient call should be the PATCH to /sandbox/sessions/ssn_IG000001/webhook-url
    expect(vi.mocked(apiClient).mock.calls[1][0]).toContain('ssn_IG000001');
    expect(vi.mocked(apiClient).mock.calls[1][0]).toContain('/webhook-url');
    expect(vi.mocked(apiClient).mock.calls[1][1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ webhookUrl: 'https://my.example/hook' }),
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm vitest run src/commands/sandbox/__tests__/webhook.test.ts
```

Expected: FAIL — `Cannot find module '../webhook.js'`.

- [ ] **Step 3: Implement `sandbox webhook *`**

Create `src/commands/sandbox/webhook.ts`:

```typescript
// `hookmyapp sandbox webhook show/set/clear` — manage the destination webhook
// URL for a sandbox session.
//
// D3/D12 migration: positional [phone] is deprecated for 0.12.2 (emits stderr
// warning, still works). Removed in 0.13.0. Positional + flag → exit 2
// (CONFLICTING_SELECTORS, per E5).

import { input } from '@inquirer/prompts';
import { apiClient } from '../../api/client.js';
import {
  parseSandboxSessions,
} from '../../api/sandbox-session.js';
import { c, icon } from '../../output/color.js';
import { ValidationError } from '../../output/error.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { sessionLabel } from './helpers.js';
import { pickSession } from './picker.js';

interface BaseOpts {
  positionalPhone?: string;
  phone?: string;
  username?: string;
  session?: string;
  json?: boolean;
}

interface SetOpts extends BaseOpts {
  url?: string;
}

function resolvePhoneFromPositional(opts: BaseOpts): string | undefined {
  if (!opts.positionalPhone) return opts.phone;
  // Positional [phone] is deprecated — see D12.
  if (opts.phone !== undefined || opts.username !== undefined || opts.session !== undefined) {
    throw new ValidationError(
      `Conflicting selectors: positional <phone> and --${
        opts.phone !== undefined ? 'phone' : opts.username !== undefined ? 'username' : 'session'
      } cannot both be provided. Use one selector.`,
      'CONFLICTING_SELECTORS',
    );
  }
  process.stderr.write(
    '[deprecated] positional <phone> on `sandbox webhook` will be removed in 0.13.0. ' +
      'Use --phone, --username, or --session.\n',
  );
  return opts.positionalPhone;
}

async function pickForWebhook(opts: BaseOpts, alwaysShowPicker: boolean) {
  const workspaceId = await getDefaultWorkspaceId();
  const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
  const sessions = parseSandboxSessions(dto);

  const phoneFlag = resolvePhoneFromPositional(opts);
  const isHuman = !opts.json && Boolean(process.stdout.isTTY);
  const session = await pickSession({
    sessions,
    phoneFlag,
    usernameFlag: opts.username,
    sessionFlag: opts.session,
    isHuman,
    alwaysShowPicker,
  });
  return { workspaceId, session };
}

export async function runSandboxWebhookShow(opts: BaseOpts): Promise<void> {
  const { session } = await pickForWebhook(opts, false);
  const url = session.webhookUrl ?? null;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ webhookUrl: url }, null, 2) + '\n');
    return;
  }
  if (!url) {
    console.log(`${sessionLabel(session)}: webhook URL not set (uses HookMyApp CLI tunnel)`);
    return;
  }
  console.log(`${sessionLabel(session)}: ${url}`);
}

export async function runSandboxWebhookSet(opts: SetOpts): Promise<void> {
  const { session } = await pickForWebhook(opts, true);
  if (!opts.url) {
    throw new ValidationError(
      '--url is required. Example: hookmyapp sandbox webhook set --phone +15551234567 --url https://example.com/webhook',
    );
  }
  // Existing backend contract: PATCH /sandbox/sessions/:id/webhook-url with a
  // JSON-stringified body. Matches the old sandbox.ts:614-619 call shape; do
  // NOT change to PUT or to an object body without updating the backend.
  await apiClient(`/sandbox/sessions/${session.id}/webhook-url`, {
    method: 'PATCH',
    body: JSON.stringify({ webhookUrl: opts.url }),
  });
  console.log(`${c.success(icon.success)} Set webhook URL on ${sessionLabel(session)}: ${opts.url}`);
}

export async function runSandboxWebhookClear(opts: BaseOpts): Promise<void> {
  const { session } = await pickForWebhook(opts, true);
  // Existing backend contract: POST /sandbox/sessions/:id/reset-webhook. Matches
  // sandbox.ts:658-660. NOT a DELETE on /webhook-url and NOT a PUT/PATCH with
  // null body — the backend has a separate reset endpoint.
  await apiClient(`/sandbox/sessions/${session.id}/reset-webhook`, {
    method: 'POST',
  });
  console.log(`${c.success(icon.success)} Cleared webhook URL on ${sessionLabel(session)}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/commands/sandbox/__tests__/webhook.test.ts
```

Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox/webhook.ts src/commands/sandbox/__tests__/webhook.test.ts
git commit -m "feat(sandbox): webhook subcommand migrates positional [phone] → flags (D3/D12, E5)"
```

---

## Task 11: Commander registration `src/commands/sandbox/index.ts`

**Files:**
- Create: `src/commands/sandbox/index.ts`

**Why:** Wires every per-subcommand `runX` into Commander, exports `registerSandboxCommand`. Replaces the entire Commander block at the bottom of the old `sandbox.ts`. Each subcommand gets `addExamples()` so `help.test.ts` continues to pass.

- [ ] **Step 1: Write the implementation**

Create `src/commands/sandbox/index.ts`:

```typescript
// `hookmyapp sandbox` — Commander registration. Wires the per-subcommand
// runX functions and attaches addExamples() to every command so help.test.ts
// continues to pass.

import type { Command } from 'commander';
import { addExamples } from '../../output/help.js';
import { runSandboxEnv } from './env.js';
import { runSandboxSend } from './send.js';
import { runSandboxStart } from './start.js';
import { runSandboxStatus } from './status.js';
import { runSandboxStop } from './stop.js';
import {
  runSandboxWebhookClear,
  runSandboxWebhookSet,
  runSandboxWebhookShow,
} from './webhook.js';

export function registerSandboxCommand(program: Command): void {
  const sandbox = program
    .command('sandbox')
    .description('Manage sandbox sessions for local development');

  const sandboxStart = sandbox
    .command('start')
    .description('Bind a sandbox session for local development')
    .option(
      '--type <whatsapp|instagram>',
      'Channel type (prompts if omitted; required in --json mode)',
    )
    .option('--listen', 'After bind, immediately start the webhook listener')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { type?: 'whatsapp' | 'instagram'; listen?: boolean; json?: boolean }) => {
      await runSandboxStart(opts);
    });
  addExamples(
    sandboxStart,
    `EXAMPLES:
  $ hookmyapp sandbox start
  $ hookmyapp sandbox start --type=whatsapp
  $ hookmyapp sandbox start --type=instagram --listen
  $ hookmyapp sandbox start --type=whatsapp --json`,
  );

  const sandboxStatus = sandbox
    .command('status')
    .description('Show active sandbox sessions')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      await runSandboxStatus(opts);
    });
  addExamples(
    sandboxStatus,
    `EXAMPLES:
  $ hookmyapp sandbox status
  $ hookmyapp sandbox status --json`,
  );

  const sandboxStop = sandbox
    .command('stop')
    .description('Delete a sandbox session')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Machine-readable output')
    .action(
      async (opts: {
        phone?: string;
        username?: string;
        session?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        await runSandboxStop(opts);
      },
    );
  addExamples(
    sandboxStop,
    `EXAMPLES:
  $ hookmyapp sandbox stop
  $ hookmyapp sandbox stop --phone +15551234567
  $ hookmyapp sandbox stop --username @ordvir
  $ hookmyapp sandbox stop --session ssn_POWomFvq --yes`,
  );

  const sandboxEnv = sandbox
    .command('env')
    .description('Print or write your sandbox .env values')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--write [path]', 'Write to file (default ./.env)')
    .option('--force', 'Overwrite without prompt')
    .option('--json', 'Machine-readable output')
    .action(
      async (opts: {
        phone?: string;
        username?: string;
        session?: string;
        write?: string | boolean;
        force?: boolean;
        json?: boolean;
      }) => {
        await runSandboxEnv(opts);
      },
    );
  addExamples(
    sandboxEnv,
    `EXAMPLES:
  $ hookmyapp sandbox env
  $ hookmyapp sandbox env --phone +15551234567 --write .env
  $ hookmyapp sandbox env --username @ordvir --write
  $ hookmyapp sandbox env --session ssn_POWomFvq --json`,
  );

  const sandboxSend = sandbox
    .command('send')
    .description('Send a test message via the shared sandbox-proxy')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--message <text>', 'Message body')
    .option('--json', 'Machine-readable output')
    .action(
      async (opts: {
        phone?: string;
        username?: string;
        session?: string;
        message?: string;
        json?: boolean;
      }) => {
        await runSandboxSend(opts);
      },
    );
  addExamples(
    sandboxSend,
    `EXAMPLES:
  $ hookmyapp sandbox send --phone +15551234567 --message "hi"
  $ hookmyapp sandbox send --username @ordvir --message "hello"
  $ hookmyapp sandbox send --session ssn_POWomFvq --message "ack"`,
  );

  const sandboxWebhook = sandbox
    .command('webhook')
    .description('Manage the destination webhook URL for a sandbox session');

  const webhookShow = sandboxWebhook
    .command('show')
    .description('Show the current webhook URL on a sandbox session')
    .argument('[phone]', '[deprecated] Use --phone instead. Removed in 0.13.0.')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        positionalPhone: string | undefined,
        opts: { phone?: string; username?: string; session?: string; json?: boolean },
      ) => {
        await runSandboxWebhookShow({ positionalPhone, ...opts });
      },
    );
  addExamples(
    webhookShow,
    `EXAMPLES:
  $ hookmyapp sandbox webhook show --phone +15551234567
  $ hookmyapp sandbox webhook show --username @ordvir
  $ hookmyapp sandbox webhook show --session ssn_POWomFvq`,
  );

  const webhookSet = sandboxWebhook
    .command('set')
    .description('Point this sandbox session at a custom webhook URL')
    .argument('[phone]', '[deprecated] Use --phone instead. Removed in 0.13.0.')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--url <url>', 'Webhook URL')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        positionalPhone: string | undefined,
        opts: {
          phone?: string;
          username?: string;
          session?: string;
          url?: string;
          json?: boolean;
        },
      ) => {
        await runSandboxWebhookSet({ positionalPhone, ...opts });
      },
    );
  addExamples(
    webhookSet,
    `EXAMPLES:
  $ hookmyapp sandbox webhook set --phone +15551234567 --url https://my.example/hook
  $ hookmyapp sandbox webhook set --username @ordvir --url https://my.example/hook
  $ hookmyapp sandbox webhook set --session ssn_POWomFvq --url https://my.example/hook`,
  );

  const webhookClear = sandboxWebhook
    .command('clear')
    .description(
      'Clear a custom webhook URL on a sandbox session (revert to HookMyApp CLI tunnel)',
    )
    .argument('[phone]', '[deprecated] Use --phone instead. Removed in 0.13.0.')
    .option('--phone <e164>', 'Select WhatsApp session by phone')
    .option('--username <handle>', 'Select Instagram session by @handle')
    .option('--session <ssn_X>', 'Select any session by id (ssn_XXXXXXXX)')
    .option('--json', 'Machine-readable output')
    .action(
      async (
        positionalPhone: string | undefined,
        opts: { phone?: string; username?: string; session?: string; json?: boolean },
      ) => {
        await runSandboxWebhookClear({ positionalPhone, ...opts });
      },
    );
  addExamples(
    webhookClear,
    `EXAMPLES:
  $ hookmyapp sandbox webhook clear --phone +15551234567
  $ hookmyapp sandbox webhook clear --username @ordvir`,
  );

  addExamples(
    sandbox,
    `EXAMPLES:
  $ hookmyapp sandbox start --type=instagram
  $ hookmyapp sandbox status
  $ hookmyapp sandbox env --username @ordvir --write
  $ hookmyapp sandbox send --username @ordvir --message "hello"`,
  );

  addExamples(
    sandboxWebhook,
    `EXAMPLES:
  $ hookmyapp sandbox webhook show --phone +15551234567
  $ hookmyapp sandbox webhook set --username @ordvir --url https://my.example/hook
  $ hookmyapp sandbox webhook clear --session ssn_POWomFvq`,
  );
}
```

- [ ] **Step 2: Verify the new module compiles**

```bash
pnpm exec tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: zero errors related to `sandbox/index.ts` (the top-level `src/index.ts` may still fail — Task 12).

- [ ] **Step 3: Commit**

```bash
git add src/commands/sandbox/index.ts
git commit -m "feat(sandbox): Commander registration with addExamples for every subcommand"
```

---

## Task 12: Switch top-level import in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Why:** Today's `src/index.ts:11` imports `registerSandboxCommand` from `./commands/sandbox.js`. After the split, the import must point at `./commands/sandbox/index.js` explicitly (NodeNext ESM does not resolve directories).

- [ ] **Step 1: Update the import**

In `src/index.ts`, find the line:

```typescript
import { registerSandboxCommand } from './commands/sandbox.js';
```

Change to:

```typescript
import { registerSandboxCommand } from './commands/sandbox/index.js';
```

- [ ] **Step 2: Verify the project compiles end-to-end**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: zero errors. (If you see errors from other test files that still reference `../sandbox.js`, those will be cleaned up in Task 16.)

- [ ] **Step 3: Build the CLI binary as a smoke check**

```bash
pnpm build
node dist/index.js sandbox --help
```

Expected output: the new `sandbox` command help with `start`, `status`, `stop`, `env`, `send`, `webhook` subcommands plus the EXAMPLES block.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "chore: switch sandbox import to new directory module"
```

---

## Task 13: `auth/login.ts` — parser integration + WA-only filter

**Files:**
- Modify: `src/auth/login.ts`

**Why:** The login wizard's `runSandboxFlow` matches sandbox sessions by phone for the legacy `--phone` auto-listen path (`login --next sandbox --phone +X`). Two narrow changes per spec Audit-5: (a) route the wire fetch through `parseSandboxSessions`, (b) filter to `type === 'whatsapp'` before the phone match so a parsed IG session can never fall into the WA-only legacy code path by accident. No new flags exposed on the login command.

- [ ] **Step 1: Locate the sandbox-session fetch in login**

```bash
cd /Users/ordvir/COD/cli
grep -n "sandbox/sessions\|SandboxSession" src/auth/login.ts | head -20
```

Note the line numbers — the wire fetch that needs parser routing is the one around line 383 (per spec — confirm at the actual file).

- [ ] **Step 2: Apply the change**

In `src/auth/login.ts`, locate the block that fetches `/sandbox/sessions?active=true` (typically inside `runSandboxFlow` or a similar helper). It looks approximately like:

```typescript
const sessions = (await apiClient('/sandbox/sessions?active=true', {
  workspaceId,
})) as SandboxSession[];
const match = sessions.find(/* phone-only matching */);
```

Replace with:

```typescript
import { parseSandboxSessions } from '../api/sandbox-session.js';

// …

const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
const allSessions = parseSandboxSessions(dto);
// `login --next sandbox --phone +X` legacy path: WA-only by definition. An IG
// session cannot fall into this code path even if one exists, because the
// matching field doesn't apply. Filter explicitly so the intent is grep-able.
const sessions = allSessions.filter((s) => s.type === 'whatsapp');
const match = sessions.find(/* the existing phone-only matching */);
```

If the file imports `type SandboxSession` from an old internal interface, remove that import — it's superseded by the wire-module type. Adjust any downstream variable typing accordingly.

- [ ] **Step 3: Update the dynamic import of `runSandboxStart`**

The login wizard dynamically imports `runSandboxStart` from the old file at `src/auth/login.ts:420`:

```typescript
const { runSandboxStart } = await import('../commands/sandbox.js');
```

This is a dynamic import — Task 15's static-import grep won't surface it, but it WILL break when `sandbox.ts` is deleted. Update it now to point at the new module:

```typescript
const { runSandboxStart } = await import('../commands/sandbox/start.js');
```

Note: `await import('../commands/sandbox-listen/index.js')` at line 450 is unchanged — `sandbox-listen` isn't being moved.

Verify with a recursive grep that no other dynamic imports of the old file path remain:

```bash
grep -rn "await import.*sandbox\.js" src/
```

(If ripgrep is installed: `rg "await import.*sandbox\.js" src` is faster but the plain-grep form works on every machine.)

Expected: zero matches. Note: dynamic imports of `'../commands/sandbox-listen/index.js'` are fine — only the bare `sandbox.js` path is problematic.

- [ ] **Step 4: Run the login wizard tests**

```bash
pnpm vitest run src/commands/__tests__/wizard.test.ts src/auth/__tests__/login.test.ts
```

Expected: PASS. If a test mocks the old wire shape, update it to mock the new parsed shape (every session needs `type`, the WA-required fields, etc.). The tests should still cover the same legacy paths — just with parser-validated fixture data.

- [ ] **Step 5: Commit**

```bash
git add src/auth/login.ts
git commit -m "feat(auth/login): parse sandbox sessions at wire boundary + WA-only filter for legacy --phone path + dynamic-import fix"
```

---

## Task 14: `sandbox-listen` picker generalization + `--username` flag

**Files:**
- Modify: `src/commands/sandbox-listen/picker.ts`
- Modify: `src/commands/sandbox-listen/index.ts`
- Modify: `src/commands/sandbox-listen/__tests__/picker.test.ts` (or `liveness.test.ts` — depending on which spec file holds the current picker tests)

**Why:** Per spec D3 + Section 3 B2, the sandbox-listen picker shares the unified `pickSession`. The local `Session` interface in `sandbox-listen/picker.ts:15` becomes a re-export of `SandboxSession` from the wire module. The wire fetch at `sandbox-listen/index.ts:323` routes through `parseSandboxSessions`. The Commander `.option()` block gains `--username <handle>`. `renderSessionTable` shows `Type | Identifier | Status | Listener`.

- [ ] **Step 1: Update `picker.ts` to use the wire module**

In `src/commands/sandbox-listen/picker.ts`, replace the `Session` interface (line ~15) and the `pickSession` body with delegates to the new module:

```typescript
// Replaces the local Session interface + pickSession function with delegates
// to the unified picker. The renderSessionTable export stays here but renders
// Type | Identifier columns instead of Phone-only.

import { pickSession as unifiedPick } from '../sandbox/picker.js';
import { sessionIdentifier } from '../sandbox/helpers.js';
import { renderTable } from '../../output/table.js';
import { c } from '../../output/color.js';
import type { SandboxSession } from '../../api/sandbox-session.js';

export type Session = SandboxSession;

export async function pickSession(args: {
  sessions: Session[];
  phoneFlag?: string;
  usernameFlag?: string;
  sessionFlag?: string;
  isHuman: boolean;
}): Promise<Session> {
  return unifiedPick({
    sessions: args.sessions,
    phoneFlag: args.phoneFlag,
    usernameFlag: args.usernameFlag,
    sessionFlag: args.sessionFlag,
    isHuman: args.isHuman,
  });
}

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
```

- [ ] **Step 2: Update `sandbox-listen/index.ts` wire fetch + add `--username` flag**

In `src/commands/sandbox-listen/index.ts`, find the wire fetch (around line 323):

```typescript
const sessions = (await apiClient('/sandbox/sessions?active=true', {
  workspaceId,
})) as Session[];
```

Replace with:

```typescript
import { parseSandboxSessions } from '../../api/sandbox-session.js';
// …
const dto = await apiClient('/sandbox/sessions?active=true', { workspaceId });
const sessions = parseSandboxSessions(dto);
```

Then in the Commander registration (around line 285-290), add the `--username` option:

```typescript
.option('--phone <e164>', 'Select WhatsApp session by phone')
.option('--username <handle>', 'Select Instagram session by @handle')
.option('--session <id>', 'Select any session by id (ssn_XXXXXXXX)')
```

And in the `action` handler, pass `usernameFlag` through:

```typescript
const chosen = await pickSession({
  sessions,
  phoneFlag: opts.phone,
  usernameFlag: opts.username,
  sessionFlag: opts.session,
  isHuman,
});
```

Update the `addExamples()` call:

```typescript
addExamples(
  sandboxListen,
  `EXAMPLES:
  $ hookmyapp sandbox listen
  $ hookmyapp sandbox listen --phone +15551234567
  $ hookmyapp sandbox listen --username @ordvir
  $ hookmyapp sandbox listen --session ssn_POWomFvq`,
);
```

- [ ] **Step 3: Update the existing picker test for IG sessions**

In `src/commands/sandbox-listen/__tests__/picker.test.ts` (or `liveness.test.ts` — whichever exercises pickSession), update the test fixtures to use the new `SandboxSession` shape (with `type`, the WA-required fields, etc.) and add at least one IG-session case:

```typescript
// Add this case to the existing describe block
it('matches an IG session by --username', async () => {
  const ig: InstagramSandboxSession = {
    id: 'ssn_IG000001',
    type: 'instagram',
    instagramSenderId: '8745912038476523',
    instagramAccountId: '17841478719287768',
    instagramSenderUsername: 'ordvir',
    accessToken: 'ACT_ig',
    hmacSecret: 'HMAC_ig',
    status: 'active',
    origin: 'demo_handoff',
  };
  const out = await pickSession({
    sessions: [ig],
    usernameFlag: '@ordvir',
    isHuman: true,
  });
  expect(out.id).toBe('ssn_IG000001');
});
```

- [ ] **Step 4: Run the listen tests**

```bash
pnpm vitest run src/commands/sandbox-listen
```

Expected: PASS — every existing test + the new IG case.

- [ ] **Step 5: Commit**

```bash
git add src/commands/sandbox-listen/picker.ts src/commands/sandbox-listen/index.ts src/commands/sandbox-listen/__tests__/
git commit -m "feat(sandbox-listen): unify picker + --username flag + parse wire data"
```

---

## Task 15: Delete the old `src/commands/sandbox.ts` and migrate `vi.mock` paths

**Files:**
- Delete: `src/commands/sandbox.ts`
- Delete: `src/commands/__tests__/sandbox-env.test.ts`
- Delete: `src/commands/__tests__/sandbox-send.test.ts`
- Delete: `src/commands/__tests__/sandbox-start.test.ts`
- Delete: `src/commands/__tests__/sandbox-start-listen.test.ts`
- Modify: any remaining file that imports from `./commands/sandbox.js`
- Modify: any remaining test that `vi.mock('../sandbox.js')` or `vi.mock('../../commands/sandbox.js')`

**Why:** The old 782-line file is fully superseded by the new directory. Its tests have new homes (Tasks 5/6/7). Any straggler `vi.mock` paths need updating to point at the per-subcommand module being mocked.

- [ ] **Step 1: Find every remaining reference (broad grep, catches static imports + vi.mock + dynamic imports)**

```bash
cd /Users/ordvir/COD/cli
grep -rn "sandbox\.js" src/ \
  | grep -v "sandbox-listen" \
  | grep -v "commands/sandbox/"
```

(Ripgrep alternative: `rg "sandbox\.js" src | rg -v sandbox-listen | rg -v 'commands/sandbox/'`.)

Expected matches (these are the known migration targets — confirm against the live grep output):
- `src/auth/__tests__/login.test.ts` — `vi.mock('../../commands/sandbox.js', ...)` declaring `registerSandboxCommand` + `runSandboxStart` + `runSandboxSend` + `runSandboxEnv`
- `src/commands/__tests__/wizard.test.ts` — `vi.mock('../sandbox.js', ...)` declaring the same four exports

If the grep surfaces anything outside this expected set, migrate or remove that reference too before proceeding.

- [ ] **Step 2: Update the test-file `vi.mock` blocks**

Each `vi.mock('../sandbox.js' | '../../commands/sandbox.js', ...)` mock targets four exports that now live in four different files. Replace each combined block with four separate mocks targeting the new per-subcommand paths.

For `src/commands/__tests__/wizard.test.ts` (currently uses path `'../sandbox.js'`), replace:

```typescript
const runSandboxStartMock = vi.fn();
vi.mock('../sandbox.js', () => ({
  registerSandboxCommand: vi.fn(),
  runSandboxStart: runSandboxStartMock,
  runSandboxSend: vi.fn(),
  runSandboxEnv: vi.fn(),
}));
```

with:

```typescript
const runSandboxStartMock = vi.fn();
vi.mock('../sandbox/index.js', () => ({
  registerSandboxCommand: vi.fn(),
}));
vi.mock('../sandbox/start.js', () => ({
  runSandboxStart: runSandboxStartMock,
}));
vi.mock('../sandbox/send.js', () => ({
  runSandboxSend: vi.fn(),
}));
vi.mock('../sandbox/env.js', () => ({
  runSandboxEnv: vi.fn(),
}));
```

For `src/auth/__tests__/login.test.ts` (currently uses path `'../../commands/sandbox.js'`), do the same split but with the `'../../commands/sandbox/...'` prefix:

```typescript
const runSandboxStartMock = vi.fn();
vi.mock('../../commands/sandbox/index.js', () => ({
  registerSandboxCommand: vi.fn(),
}));
vi.mock('../../commands/sandbox/start.js', () => ({
  runSandboxStart: runSandboxStartMock,
}));
vi.mock('../../commands/sandbox/send.js', () => ({
  runSandboxSend: vi.fn(),
}));
vi.mock('../../commands/sandbox/env.js', () => ({
  runSandboxEnv: vi.fn(),
}));
```

After updating both files, re-run the broad grep:

```bash
grep -rn "sandbox\.js" src/ \
  | grep -v "sandbox-listen" \
  | grep -v "commands/sandbox/"
```

Expected: no output. Every reference now points at the new directory layout.

- [ ] **Step 3: Delete the old files**

```bash
git rm src/commands/sandbox.ts
git rm src/commands/__tests__/sandbox-env.test.ts
git rm src/commands/__tests__/sandbox-send.test.ts
git rm src/commands/__tests__/sandbox-start.test.ts
git rm src/commands/__tests__/sandbox-start-listen.test.ts
```

- [ ] **Step 4: Verify the full test suite passes**

```bash
pnpm vitest run
```

Expected: PASS — every test green. If a wizard or login test fails because of a stale `vi.mock` path, fix it now (the per-subcommand mock target depends on what the test was asserting; pick the new file that owns the export).

- [ ] **Step 5: Verify the full typecheck passes**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: zero errors.

- [ ] **Step 6: Verify the build passes**

```bash
pnpm build
node dist/index.js sandbox status --help
```

Expected: the help banner renders with the new flag set.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore(sandbox): delete legacy src/commands/sandbox.ts + migrate vi.mock paths"
```

---

## Task 16: README + final CHANGELOG polish

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Why:** README's command-table section may name `sandbox env`, `sandbox send`, etc. with WhatsApp-specific copy. Update to channel-agnostic language per spec D5. Finalize the CHANGELOG entry now that all the actual changes have landed.

- [ ] **Step 1: Read the README sandbox section**

```bash
grep -n "sandbox\|--phone\|WHATSAPP" README.md | head -40
```

Identify any WA-flavored copy (e.g., "your WhatsApp number", "Bind WhatsApp phone") in shared `sandbox` documentation. Per D5, shared strings become channel-agnostic. Per-subcommand examples can stay channel-specific.

- [ ] **Step 2: Apply channel-agnostic edits to shared `sandbox` copy**

Example changes (the actual lines depend on what's in your README):

```markdown
- # `hookmyapp sandbox start` — bind your WhatsApp phone to a sandbox session
+ # `hookmyapp sandbox start` — bind a sandbox session for local development
+
+ Choose `--type=whatsapp` to bind a WhatsApp phone, or `--type=instagram` to
+ bind an Instagram handle. If `--type` is omitted in TTY mode, the CLI
+ prompts; in `--json` mode the flag is required.
```

Add an example for IG flow under the existing WA example block:

```markdown
## Instagram example

```bash
# Bind an Instagram sandbox session
hookmyapp sandbox start --type=instagram

# Get the .env values
hookmyapp sandbox env --username @ordvir --write .env

# Send a test reply
hookmyapp sandbox send --username @ordvir --message "hello"
```
```

- [ ] **Step 3: Finalize the CHANGELOG entry**

Open `CHANGELOG.md` and convert the `## 0.12.2 (unreleased)` heading to `## 0.12.2` (no parenthetical), assuming we're cutting the release at the end of this work. If the operator wants to ship from main directly, leave `(unreleased)` for now and remove at the actual release step.

Verify each bullet of the 0.12.2 entry is still accurate. Add any item that landed differently than scaffolded in Task 0.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: README IG example + finalize 0.12.2 CHANGELOG"
```

---

## Task 17: Final verification — typecheck, full test suite, build, smoke run

**Files:** none modified.

**Why:** Ship gate. Every gate must pass before the PR is ready for review.

- [ ] **Step 1: Full typecheck**

```bash
cd /Users/ordvir/COD/cli
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: zero errors. (This CLI has no `lint` script and no ESLint dependency, so the typecheck IS the static-analysis gate.)

- [ ] **Step 2: Full test suite**

```bash
pnpm vitest run
```

Expected: every test green. Note the totals — the new suite should add ~50+ tests across parser, helpers, picker, env, send, start, webhook, and listen-picker.

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: clean build, `dist/index.js` produced.

- [ ] **Step 4: Smoke check the built CLI**

```bash
node dist/index.js --version
node dist/index.js sandbox --help
node dist/index.js sandbox start --help
node dist/index.js sandbox env --help
```

Expected:
- Version is `0.12.2`
- `sandbox --help` shows `start`, `status`, `stop`, `env`, `send`, `webhook` + EXAMPLES
- `sandbox start --help` shows the `--type` flag + EXAMPLES with `--type=instagram` shown
- `sandbox env --help` shows `--phone`, `--username`, `--session` selectors

- [ ] **Step 5: Smoke check `--json` non-interactive paths**

```bash
node dist/index.js sandbox start --json 2>&1
```

Expected: stderr `--type is required in --json mode (use --type=whatsapp or --type=instagram).`, exit code 2.

```bash
echo $?  # ← run this immediately after the previous command
```

Expected: `2`.

- [ ] **Step 6: If everything passes, push the branch**

```bash
git push -u origin feat/instagram-sandbox
```

Expected: branch pushed. CI runs (Depot CI / GitHub Actions per the CLI's existing release workflow); confirm all checks pass before opening the PR.

- [ ] **Step 7: Open the PR**

```bash
gh pr create --title "feat(sandbox): Instagram support (0.12.2)" --body "$(cat <<'EOF'
## Summary

- Adds Instagram parity across `sandbox env`, `sandbox send`, `sandbox start`, `sandbox status`, `sandbox stop`, `sandbox webhook show/set/clear`, `sandbox listen` for local + staging environments.
- Unifies the sandbox selector contract to `--phone | --username | --session` across all five sandbox subcommand groups.
- Introduces a wire-boundary parser (`src/api/sandbox-session.ts`) that produces a discriminated union; the four `as SandboxSession[]` casts (in sandbox env/send, sandbox-listen, auth/login) are deleted.
- Splits the 782-line `src/commands/sandbox.ts` into per-subcommand files under `src/commands/sandbox/`.
- Deprecates the positional `[phone]` argument on `sandbox webhook show/set/clear` for one release; removed no earlier than 0.13.0.
- Production `sandbox start --type=instagram` fails fast with `ConfigurationError` until the prod IG sandbox handle is provisioned (per project memory `reference_sandbox_ig_account`).

Spec: `docs/superpowers/specs/2026-05-25-instagram-sandbox-cli-design.md`
Plan: `docs/superpowers/plans/2026-05-25-cli-instagram-sandbox.md`

## Test plan

- [x] Parser rejects every malformed-shape path with `UnexpectedError/MALFORMED_SANDBOX_SESSION`
- [x] `buildEnvBlock` emits unchanged 5-line WA block + new 5-line IG block
- [x] `buildSandboxSendRequest` produces correct URL + body for WA + IG
- [x] Picker supports `--phone | --username | --session` with all conflict/mismatch/null-backfill paths
- [x] `sandbox start --type=instagram` builds `ig.me/m/{handle}?text=` URL (no `@` in path, encoded code)
- [x] `sandbox start --type=instagram` in production throws `ConfigurationError`
- [x] `sandbox start --json` without `--type` throws `ValidationError` exit 2
- [x] `sandbox send` IG path extracts `message_id` from flat IG response
- [x] `SESSION_WINDOW_CLOSED` 403 surfaces `body.message` verbatim
- [x] `sandbox webhook show/set/clear` positional `[phone]` works with deprecation warning
- [x] `sandbox webhook` positional + flag → `CONFLICTING_SELECTORS` exit 2
- [x] `sandbox-listen` accepts `--username` and renders Type + Identifier columns
- [x] Login wizard parses sandbox sessions and filters to WA-only for the legacy `--phone` path

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review

This plan covers every spec decision and corner case:

- **D1** (`sandbox start --type` chooser) — Task 7
- **D2** (`INSTAGRAM_*` env block) — Task 5
- **D3** (selector unification across 5 surfaces) — Tasks 4, 5, 6, 9, 10, 14
- **D4** (IG env no tester id) — Task 5 (explicit; the test asserts the 5-line shape)
- **D5** (channel-agnostic shared copy) — Tasks 7, 8, 11, 16
- **D6** (single PR shipping unit) — entire plan is one PR
- **D7** (boundary parser + discriminated union) — Task 1
- **D8** (shared helpers) — Task 3
- **D9** (`UnexpectedError/MALFORMED_SANDBOX_SESSION` exit 1) — Task 1
- **D10** (production IG fail-fast) — Tasks 2, 7
- **D11** (`SESSION_MISMATCH` via `CliError + exitCode=2`) — Task 4
- **D12** (`sandbox webhook` positional deprecation runway) — Task 10
- **D13** (no IG integration tests) — entire plan stays at unit/command-runner level

Branch-point coverage:

- (1) `buildEnvBlock` — Task 5
- (2) `runSandboxSend` — Task 6
- (3) `runSandboxStart` — Task 7
- (4) `runSandboxStatus` — Task 8
- (5) `pickSession` env/send — Task 4 + 5 + 6
- (6) `pickSession` sandbox-listen — Task 14
- (7) `sandbox stop` — Task 9
- (8) `sandbox webhook show/set/clear` — Task 10
- (9) `auth/login.ts` parser + WA-only filter — Task 13
- (10) `sandbox-listen/index.ts` parser integration — Task 14

Error pathway coverage (E1–E8 from spec Section 4):

- **E1** (`MALFORMED_SANDBOX_SESSION`) — Task 1 tests
- **E2** (prod IG `ConfigurationError`) — Tasks 2, 7 tests
- **E3** (`--type` required in JSON) — Task 7 test
- **E4** (`CONFLICTING_SELECTORS` flag-vs-flag) — Task 4 tests
- **E5** (`CONFLICTING_SELECTORS` positional-vs-flag) — Task 10 tests
- **E6** (`SESSION_MISMATCH` with null-backfill IG) — Task 4 test
- **E7** (generic `SESSION_MISMATCH`) — Task 4 tests
- **E8** (`SESSION_WINDOW_CLOSED` verbatim) — Task 6 test

Placeholder scan: every step contains code or commands. No "TODO", "TBD", "implement later". Migration table for `vi.mock` paths in Task 15 spells out which paths move where. Production fail-fast wording is the exact `ConfigurationError` constructor signature (positional, per `src/output/error.ts:92`).

Type consistency: `SandboxSession` / `WhatsAppSandboxSession` / `InstagramSandboxSession` defined in Task 1 and used consistently across Tasks 3, 4, 5, 6, 7, 8, 9, 10, 14. Helper names match across tasks: `sessionIdentifier`, `sessionLabel`, `buildSandboxSendRequest`, `pickSession`, `parseSandboxSession`, `parseSandboxSessions`, `assertNever`, `INSTAGRAM_GRAPH_VERSION`.
