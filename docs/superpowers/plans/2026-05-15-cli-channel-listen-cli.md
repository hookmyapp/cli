# CLI Channel Listen — CLI Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `@gethookmyapp/cli` changes that add the `hookmyapp channels listen` command — a near-mirror of `hookmyapp sandbox listen`, but for real onboarded WABA channels via the new `/api/channels/:id/tunnel/{start,configure,heartbeat,stop}` endpoints. Source spec: `/Users/ordvir/COD/hookmyapp/docs/superpowers/specs/2026-05-15-cli-channel-listen-design.md`.

**Architecture:** Clone of `src/commands/sandbox-listen/` into `src/commands/channels-listen/`. Reuses `binary.ts`, `proxy-server.ts`, `summarizer.ts`, and `lifecycle.ts` (the cloudflared subprocess + heartbeat machinery) verbatim via imports — only the picker and the API paths change. New top-level wizard branch lets users pick between sandbox and real-channel listening. Heartbeat loop catches the new `410 CHANNEL_TUNNEL_RECLAIMED` terminal status from the backend and exits 0 cleanly.

**Tech Stack:** TypeScript, commander 14, `@inquirer/prompts`, vitest. Published to npm with sigstore provenance per the existing release flow.

**IMPORTANT — Repo location:** Every path in this plan is inside the **CLI repo at `/Users/ordvir/COD/cli`**, NOT the hookmyapp monorepo. The monorepo work lives in the companion plan `docs/superpowers/plans/2026-05-15-cli-channel-listen-monorepo.md` and **must be deployed to staging+prod first**.

**Plan file location — canonical copy in monorepo; Task 0 imports to CLI repo.**

The canonical copy of this plan and its source spec live in the **monorepo**:
- Plan: `/Users/ordvir/COD/hookmyapp/docs/superpowers/plans/2026-05-15-cli-channel-listen-cli.md`
- Spec: `/Users/ordvir/COD/hookmyapp/docs/superpowers/specs/2026-05-15-cli-channel-listen-design.md`

The CLI repo at `/Users/ordvir/COD/cli` does NOT currently contain these files. Before starting Task 1, run Task 0 below to import (copy) them into the CLI repo so a CLI-repo worker has local access. Updates to either file should happen in the monorepo first; re-run Task 0 to refresh the CLI-repo copy when the canonical copy changes.

**Task 0 (one-shot bootstrap, before Task 1):**

```bash
mkdir -p /Users/ordvir/COD/cli/docs/superpowers/plans
mkdir -p /Users/ordvir/COD/cli/docs/superpowers/specs

cp /Users/ordvir/COD/hookmyapp/docs/superpowers/plans/2026-05-15-cli-channel-listen-cli.md \
   /Users/ordvir/COD/cli/docs/superpowers/plans/2026-05-15-cli-channel-listen-cli.md

cp /Users/ordvir/COD/hookmyapp/docs/superpowers/specs/2026-05-15-cli-channel-listen-design.md \
   /Users/ordvir/COD/cli/docs/superpowers/specs/2026-05-15-cli-channel-listen-design.md

cd /Users/ordvir/COD/cli
git add docs/superpowers/
git commit -m "docs: import channel-listen plan + spec from monorepo (canonical lives there)"
```

That commit imports the working copy. All subsequent CLI work happens in `/Users/ordvir/COD/cli`. If the canonical plan/spec in the monorepo is updated mid-execution, re-run the two `cp` commands and commit again with `docs: refresh channel-listen plan from monorepo`.

**Hard dependency:** Do NOT cut a release of this CLI plan until the monorepo plan has shipped to production and a manual `curl` smoke (monorepo Task 20) has confirmed the channel-tunnel endpoints work in prod. The CLI's version-pinning (Task 1) is the second line of defense, not the first.

---

## Task 1: CLI version bump + minimum-required-backend version pin

**Files:**
- Modify: `/Users/ordvir/COD/cli/package.json` (version)
- Modify: `/Users/ordvir/COD/cli/src/version-check.ts` (or wherever the existing min-backend-version pin lives — see `docs/superpowers/specs/2026-05-06-cli-and-skill-version-enforcement-design.md` in the monorepo)

**Why:** The new CLI must refuse to call channel-tunnel endpoints if it's pointed at a backend that hasn't shipped them. The existing `cli-and-skill-version-enforcement` mechanism declares a minimum required backend version inside the CLI; bump it.

- [ ] **Step 1: Find where the backend-version pin lives**

```bash
cd /Users/ordvir/COD/cli
grep -rnE "MIN_BACKEND_VERSION|minBackendVersion|x-required-backend|requiredBackend" src 2>/dev/null
```

Note the file + constant name.

- [ ] **Step 2: Bump CLI version to 0.12.0**

In `package.json`:

```json
{
  "name": "@gethookmyapp/cli",
  "version": "0.12.0",
  ...
}
```

- [ ] **Step 3: Bump minimum backend version**

Update the constant from Step 1 to the version tag that the monorepo plan ships under (look in the monorepo's `package.json` or release tag after monorepo deploy lands; e.g., if monorepo ships as `v1.5.0`, set `MIN_BACKEND_VERSION = '1.5.0'`).

- [ ] **Step 4: Verify the existing version-check still passes its tests**

```bash
pnpm test -- version-check --reporter=verbose
```

Expected: all existing tests still pass. (The constant change is data-only; the check logic is unchanged.)

- [ ] **Step 5: Commit**

```bash
git add package.json src/version-check.ts
git commit -m "chore: bump to 0.12.0 + raise min backend version for channel-listen endpoints"
```

(Replace `version-check.ts` path with whatever Step 1 surfaced.)

---

## Task 2: Channel picker module

**Files:**
- Create: `/Users/ordvir/COD/cli/src/commands/channels-listen/picker.ts`
- Create: `/Users/ordvir/COD/cli/src/commands/channels-listen/__tests__/picker.test.ts`

**Why:** Lists workspace channels with `forwardingEnabled=true` (filterable client-side) so the user can pick one. Mirrors `src/commands/sandbox-listen/picker.ts` but reads from `/meta/channels` instead of `/sandbox/sessions`.

- [ ] **Step 1: Read the sandbox picker for reference**

```bash
cat /Users/ordvir/COD/cli/src/commands/sandbox-listen/picker.ts
```

Note: the test file structure (`__tests__/picker.test.ts`) — copy its patterns.

- [ ] **Step 2: Write the failing picker test**

Create `src/commands/channels-listen/__tests__/picker.test.ts`:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { pickChannel, type Channel } from '../picker';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));
import { select } from '@inquirer/prompts';

describe('pickChannel', () => {
  test('When user provides --channel publicId and it matches, then returns that channel without prompting', async () => {
    const channels: Channel[] = [
      { publicId: 'ch_aaaaaaaa', displayPhoneNumber: '+1 (555) 111-1111', wabaName: 'A', forwardingEnabled: true },
      { publicId: 'ch_bbbbbbbb', displayPhoneNumber: '+1 (555) 222-2222', wabaName: 'B', forwardingEnabled: true },
    ];
    const picked = await pickChannel(channels, { channelPublicId: 'ch_bbbbbbbb' });
    expect(picked.publicId).toBe('ch_bbbbbbbb');
    expect(select).not.toHaveBeenCalled();
  });

  test('When no --channel flag and 2+ channels, then prompts via select', async () => {
    vi.mocked(select).mockResolvedValueOnce('ch_aaaaaaaa');
    const channels: Channel[] = [
      { publicId: 'ch_aaaaaaaa', displayPhoneNumber: '+1 (555) 111-1111', wabaName: 'A', forwardingEnabled: true },
      { publicId: 'ch_bbbbbbbb', displayPhoneNumber: '+1 (555) 222-2222', wabaName: 'B', forwardingEnabled: true },
    ];
    const picked = await pickChannel(channels, {});
    expect(picked.publicId).toBe('ch_aaaaaaaa');
    expect(select).toHaveBeenCalledOnce();
  });

  test('When --channel does not match any channel, then throws ValidationError', async () => {
    const channels: Channel[] = [
      { publicId: 'ch_aaaaaaaa', displayPhoneNumber: '+1 (555) 111-1111', wabaName: 'A', forwardingEnabled: true },
    ];
    await expect(pickChannel(channels, { channelPublicId: 'ch_nonexis1' })).rejects.toThrow(/not found/i);
  });

  test('When only forwarding-disabled channels exist, then throws ValidationError', async () => {
    const channels: Channel[] = [
      { publicId: 'ch_aaaaaaaa', displayPhoneNumber: '+1 (555) 111-1111', wabaName: 'A', forwardingEnabled: false },
    ];
    await expect(pickChannel(channels, {})).rejects.toThrow(/forwarding/i);
  });
});
```

- [ ] **Step 3: Run — expect FAIL (module not found)**

```bash
pnpm test -- channel/listen/picker --reporter=verbose
```

- [ ] **Step 4: Create the picker module**

Write `src/commands/channels-listen/picker.ts`:

```typescript
import { select } from '@inquirer/prompts';
import { ValidationError } from '../../output/error.js';

export interface Channel {
  publicId: string;
  displayPhoneNumber: string | null;
  wabaName: string | null;
  forwardingEnabled: boolean;
}

export interface PickChannelOpts {
  channelPublicId?: string;
}

export async function pickChannel(channels: Channel[], opts: PickChannelOpts): Promise<Channel> {
  const eligible = channels.filter((c) => c.forwardingEnabled);
  if (eligible.length === 0) {
    throw new ValidationError(
      'No channels have forwarding enabled. Enable forwarding on a channel in the dashboard before connecting the CLI.',
    );
  }

  if (opts.channelPublicId) {
    const match = eligible.find((c) => c.publicId === opts.channelPublicId);
    if (!match) {
      throw new ValidationError(
        `Channel ${opts.channelPublicId} not found in this workspace (or forwarding is disabled).`,
      );
    }
    return match;
  }

  if (eligible.length === 1) return eligible[0];

  const chosen = await select<string>({
    message: 'Pick a channel to listen on:',
    choices: eligible.map((c) => ({
      value: c.publicId,
      name: `${c.displayPhoneNumber ?? '<no phone>'} — ${c.wabaName ?? c.publicId}`,
    })),
  });
  return eligible.find((c) => c.publicId === chosen)!;
}
```

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/commands/channels-listen/picker.ts src/commands/channels-listen/__tests__/picker.test.ts
git commit -m "feat(cli): channel picker for `channels listen` flow"
```

---

## Task 3: Channel-listen lifecycle wrapper — adapts existing `lifecycle.ts` heartbeat to new endpoint + handles 410

**Files:**
- Modify: `/Users/ordvir/COD/cli/src/commands/sandbox-listen/lifecycle.ts` (extract `startHeartbeat` to be path-parameterized, or leave it sandbox-specific and write a parallel `startChannelHeartbeat`)
- Create: `/Users/ordvir/COD/cli/src/commands/channels-listen/lifecycle.ts`
- Create: `/Users/ordvir/COD/cli/src/commands/channels-listen/__tests__/lifecycle.test.ts`

**Why:** Heartbeat loop today calls `/sandbox/sessions/:id/tunnel/heartbeat` and tolerates one transient failure. For `channels listen` it calls `/channels/:id/tunnel/heartbeat` AND must recognize a `410 CHANNEL_TUNNEL_RECLAIMED` AppError code as a terminal signal — exit 0 with the userMessage.

- [ ] **Step 1: Decide: extract or parallel**

Read `src/commands/sandbox-listen/lifecycle.ts`. The function `startHeartbeat` takes `sessionId` and constructs a path like `/sandbox/sessions/${sessionId}/tunnel/heartbeat`. Two options:

(a) Parameterize: change `startHeartbeat` to take a `heartbeatPath: string` arg.
(b) Parallel: write a `startChannelHeartbeat` that mirrors the same internals but uses `/channels/:id/tunnel/heartbeat` AND adds 410 handling.

Option (b) is simpler (sandbox lifecycle has no need for 410 handling; not all sandbox-side changes would benefit). **Pick (b).**

- [ ] **Step 2: Write the test for `startChannelHeartbeat`**

Create `src/commands/channels-listen/__tests__/lifecycle.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { startChannelHeartbeat } from '../lifecycle';

vi.mock('../../api/client.js', () => ({
  apiClient: vi.fn(),
}));
import { apiClient } from '../../api/client.js';

describe('startChannelHeartbeat', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

  test('When backend returns 204 every tick, then heartbeat fires every 30s indefinitely', async () => {
    vi.mocked(apiClient).mockResolvedValue(undefined);
    const onError = vi.fn();
    const onTerminal = vi.fn();
    const handle = startChannelHeartbeat({ channelPublicId: 'ch_xxxxxxxx', workspaceId: 'ws_y', onError, onTerminal });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiClient).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiClient).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();

    handle.stop();
  });

  test('When backend returns 410 CHANNEL_TUNNEL_RECLAIMED, then calls onTerminal with the userMessage and stops the loop', async () => {
    const reclaimError = Object.assign(new Error('tunnel reclaimed'), {
      status: 410,
      code: 'CHANNEL_TUNNEL_RECLAIMED',
      userMessage: "This channel's destination was changed. The CLI listener has been stopped.",
    });
    vi.mocked(apiClient).mockRejectedValue(reclaimError);
    const onError = vi.fn();
    const onTerminal = vi.fn();
    const handle = startChannelHeartbeat({ channelPublicId: 'ch_xxxxxxxx', workspaceId: 'ws_y', onError, onTerminal });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onTerminal).toHaveBeenCalledWith({
      code: 'CHANNEL_TUNNEL_RECLAIMED',
      userMessage: "This channel's destination was changed. The CLI listener has been stopped.",
    });
    expect(onError).not.toHaveBeenCalled();

    // After terminal, further ticks must not fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(apiClient).toHaveBeenCalledOnce();

    handle.stop();
  });

  test('When backend transiently fails (5xx), then tolerates one failure and continues; calls onError on second consecutive', async () => {
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('500'));
    vi.mocked(apiClient).mockRejectedValueOnce(new Error('500'));
    const onError = vi.fn();
    const onTerminal = vi.fn();
    const handle = startChannelHeartbeat({ channelPublicId: 'ch_xxxxxxxx', workspaceId: 'ws_y', onError, onTerminal });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledOnce();

    handle.stop();
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `lifecycle.ts`**

Write `src/commands/channels-listen/lifecycle.ts`:

```typescript
import { apiClient } from '../../api/client.js';

export interface HeartbeatHandle {
  stop: () => void;
}

export interface ChannelHeartbeatTerminal {
  code: string;
  userMessage: string;
}

export interface ChannelHeartbeatOpts {
  channelPublicId: string;
  workspaceId: string;
  intervalMs?: number;
  onError: (err: unknown) => void;       // called after 2nd consecutive transient failure
  onTerminal: (t: ChannelHeartbeatTerminal) => void;  // called when backend returns a terminal status (e.g. 410)
}

/**
 * Ping /channels/:id/tunnel/heartbeat on a fixed interval.
 * - Tolerates a single transient failure; calls onError on the 2nd consecutive.
 * - Stops the loop on a terminal AppError code (410 CHANNEL_TUNNEL_RECLAIMED).
 */
export function startChannelHeartbeat(opts: ChannelHeartbeatOpts): HeartbeatHandle {
  const interval = opts.intervalMs ?? 30_000;
  let consecutiveErrors = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await apiClient(`/channels/${opts.channelPublicId}/tunnel/heartbeat`, {
        method: 'POST',
        workspaceId: opts.workspaceId,
      });
      consecutiveErrors = 0;
    } catch (err: unknown) {
      // Terminal AppError codes — stop the loop, surface to caller.
      const e = err as { code?: string; userMessage?: string; status?: number };
      if (e.code === 'CHANNEL_TUNNEL_RECLAIMED' || e.status === 410) {
        stopped = true;
        clearInterval(handle);
        opts.onTerminal({
          code: e.code ?? 'CHANNEL_TUNNEL_RECLAIMED',
          userMessage: e.userMessage ?? "This channel's destination was changed. The CLI listener has been stopped.",
        });
        return;
      }

      consecutiveErrors++;
      if (consecutiveErrors >= 2) {
        opts.onError(err);
      }
    }
  };

  const handle = setInterval(tick, interval);

  return {
    stop: () => { stopped = true; clearInterval(handle); },
  };
}
```

(Adapt the `apiClient` call shape to match the existing `apiClient` signature — check `sandbox-listen/lifecycle.ts:158` for the existing pattern. The `workspaceId` arg may be passed as part of an `opts` object.)

- [ ] **Step 5: Run — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/commands/channels-listen/lifecycle.ts src/commands/channels-listen/__tests__/lifecycle.test.ts
git commit -m "feat(cli): channel heartbeat with 410 CHANNEL_TUNNEL_RECLAIMED terminal handling"
```

---

## Task 4: `channels listen` command wiring (under the existing `channels` parent)

**Files:**
- Modify: `/Users/ordvir/COD/cli/src/commands/channels.ts` (existing plural parent — register the new subcommand)
- Create: `/Users/ordvir/COD/cli/src/commands/channels-listen/index.ts` (the action handler + its supporting modules)

**Why:** The actual command. Mirrors `src/commands/sandbox-listen/index.ts` step-by-step, but uses the channel picker + channel-tunnel endpoints + the new lifecycle's 410 handling.

**Important — use the existing plural `channels` command parent, not a new singular `channel`.** The CLI already has `hookmyapp channels` at `/Users/ordvir/COD/cli/src/commands/channels.ts` (see `commands/channels.ts:116`). Introducing a parallel `channel` (singular) would surface as a confusing UX inconsistency in `--help` and risks Commander parse-precedence ambiguity. The new command is therefore `hookmyapp channels listen [--channel <publicId>]`.

The `picker.ts` and `lifecycle.ts` modules from Tasks 2–3 sit under the same directory (`src/commands/channels-listen/`) to keep co-located. The `picker.ts` / `lifecycle.ts` paths referenced in Tasks 2–3 are inside `src/commands/channels-listen/`, not `src/commands/channels-listen/`. Update those task paths accordingly if you scaffold them as `src/commands/channels-listen/` first — rename before commit.

- [ ] **Step 1: Read the sandbox-listen index for reference**

```bash
cat /Users/ordvir/COD/cli/src/commands/sandbox-listen/index.ts | head -250
```

Note the 11-step flow it documents at the top. The `channels listen` flow is the same shape, with these substitutions:
- Step 4 fetches `/meta/channels` instead of `/sandbox/sessions?active=true`.
- Step 5 calls `pickChannel(...)` (from Task 2) instead of `pickSession(...)`.
- Step 6 calls `POST /channels/:id/tunnel/start` instead of `POST /sandbox/sessions/:id/tunnel/start`.
- Step 7 calls `POST /channels/:id/tunnel/configure`.
- Step 9 uses `startChannelHeartbeat` (Task 3) instead of `startHeartbeat`.
- Cleanup (Ctrl-C) calls `POST /channels/:id/tunnel/stop`.

- [ ] **Step 2: Create `commands/channel/listen/index.ts`**

```typescript
// `hookmyapp channels listen` — mirror of sandbox-listen for real onboarded channels.
// See sandbox-listen/index.ts for the canonical step-by-step shape.

import type { Command } from 'commander';
import { apiClient } from '../../api/client.js';
import { CliError, AuthError } from '../../output/error.js';
import { resolveEnv } from '../../config/env-profiles.js';
import { readCredentials } from '../../auth/store.js';
import { getDefaultWorkspaceId } from '../_helpers.js';
import { ensureCloudflaredBinary } from '../sandbox-listen/binary.js';
import { startProxyServer, type LogLine } from '../sandbox-listen/proxy-server.js';
import { spawnCloudflared, gracefulShutdown, markShuttingDown } from '../sandbox-listen/lifecycle.js';
import { startChannelHeartbeat } from './lifecycle.js';
import { pickChannel, type Channel } from './picker.js';
import { checkForNewerCli } from '../sandbox-listen/version-check.js';
import { emit, getCliVersion } from '../../observability/posthog.js';

export interface ChannelListenOpts {
  port: number;
  path: string;
  channel?: string;
  verbose: boolean;
  json: boolean;
  reinstallTunnelBinary: boolean;
}

export interface TunnelStartResponse {
  cloudflareTunnelToken: string;
  hostname: string;
  webhookPath?: string;
}

export function registerChannelsListenCommand(channels: Command): void {
  channels
    .command('listen')
    .description('Listen for inbound WhatsApp messages on a real channel via the HookMyAppCLI tunnel.')
    .option('-p, --port <port>', 'Local port your code listens on', (v) => parseInt(v, 10), 3000)
    .option('-P, --path <path>', 'Local path your code expects', '/webhook')
    .option('-c, --channel <publicId>', 'Channel publicId (ch_...) to listen on (skip the picker)')
    .option('-v, --verbose', 'Show verbose tunnel logs', false)
    .option('--json', 'Emit JSON log lines instead of human-readable', false)
    .option('--reinstall-tunnel-binary', 'Force re-download of cloudflared', false)
    .action(async (opts: ChannelListenOpts) => {
      const human = !opts.json;
      const startedAt = Date.now();

      // Step 1 — auth gate
      const creds = await readCredentials();
      if (!creds) {
        throw new AuthError('Not logged in. Run `hookmyapp login` first.');
      }

      // Step 2 — version check
      await checkForNewerCli();

      // Step 3 — cloudflared binary
      let binaryPath: string;
      try {
        binaryPath = await ensureCloudflaredBinary({ force: opts.reinstallTunnelBinary });
      } catch (err) {
        if (err instanceof CliError) { console.error(`cloudflared: ${err.userMessage}`); process.exit(4); }
        throw err;
      }

      // Step 4 — fetch channels
      const workspaceId = await getDefaultWorkspaceId();
      const channels = (await apiClient('/meta/channels', { workspaceId })) as Channel[];

      // Step 5 — pick
      const channel = await pickChannel(channels, { channelPublicId: opts.channel });
      if (human) console.log(`Connecting CLI to channel ${channel.publicId} (${channel.displayPhoneNumber ?? '<no phone>'})…`);

      // Step 6 — start tunnel (no body — backend treats fresh heartbeat as
      // "same listener", per monorepo plan Task 6's idempotency semantics)
      const tunnel = (await apiClient(
        `/channels/${channel.publicId}/tunnel/start`,
        { method: 'POST', body: {}, workspaceId },
      )) as TunnelStartResponse;

      // Step 7 — proxy server on free local port
      const proxy = await startProxyServer({
        upstreamPort: opts.port,
        upstreamPath: opts.path,
        onRequest: (line: LogLine) => {
          if (opts.json) console.log(JSON.stringify(line));
          else console.log(`${line.ts}  ${line.method} ${line.path}  ${line.status}  ${line.ms}ms  ${line.summary}`);
        },
      });

      // Step 7b — configure ingress
      await apiClient(
        `/channels/${channel.publicId}/tunnel/configure`,
        { method: 'POST', body: { port: proxy.port, path: opts.path }, workspaceId },
      );

      // Step 8 — spawn cloudflared
      const cf = spawnCloudflared({ binaryPath, token: tunnel.cloudflareTunnelToken });

      // Step 9 — heartbeat
      const hb = startChannelHeartbeat({
        channelPublicId: channel.publicId,
        workspaceId,
        onError: (err) => {
          console.error(`Heartbeat failed twice in a row: ${err instanceof Error ? err.message : String(err)}`);
        },
        onTerminal: (t) => {
          if (human) console.log(`\n${t.userMessage}`);
          // 410 reclaim is a clean exit. Emit `_stopped` with the duration so
          // the funnel sees the session terminate cleanly (vs. crash). Matches
          // sandbox's clean-exit emit pattern.
          void emit('cli_channel_listen_stopped', {
            cli_version: getCliVersion(),
            channel_public_id: channel.publicId,
            duration_seconds: Math.floor((Date.now() - startedAt) / 1000),
          });
          // Stop cloudflared + proxy gracefully, then exit 0.
          markShuttingDown();
          cf.kill('SIGTERM');
          void proxy.close().finally(() => process.exit(0));
        },
      });

      // Step 10–11 — graceful shutdown on Ctrl-C / SIGTERM
      const shutdown = () => {
        hb.stop();
        void emit('cli_channel_listen_stopped', {
          cli_version: getCliVersion(),
          channel_public_id: channel.publicId,
          duration_seconds: Math.floor((Date.now() - startedAt) / 1000),
        });
        gracefulShutdown({
          child: cf,
          proxy,
          onCleanup: async () => {
            try {
              await apiClient(`/channels/${channel.publicId}/tunnel/stop`, { method: 'POST', workspaceId });
            } catch { /* best-effort */ }
          },
        });
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      if (human) console.log(`Tunnel up at https://${tunnel.hostname}${tunnel.webhookPath ?? '/webhook'} → http://localhost:${opts.port}${opts.path}\nPress Ctrl-C to stop.`);

      // Fires after tunnel is live + heartbeat loop running (matches sandbox-listen's
      // emit position in src/commands/sandbox-listen/index.ts:176).
      void emit('cli_channel_listen_started', {
        cli_version: getCliVersion(),
        channel_public_id: channel.publicId,
        workspace_public_id: workspaceId,
      });

      // 2h liveness backstop — same pattern as sandbox-listen's
      // src/commands/sandbox-listen/lifecycle.ts:283. Add via
      // `startPosthogLiveness` if you copy the helper, or inline.
    });
}
```

(Adapt argument names / `apiClient` signature / `gracefulShutdown` signature to match what already exists — the snippet above is structurally accurate but may need name tweaks where sandbox-listen has diverged.)

- [ ] **Step 3: Hook the new subcommand into the existing `channels` parent**

The existing `channels` parent command lives at `src/commands/channels.ts` (created in `commands/channels.ts:116` via `program.command('channels').description('Manage WhatsApp channels')`). Don't introduce a parallel singular `channel` command — wire `listen` into the existing plural parent.

In `src/commands/channels.ts`, locate the `channels` parent command builder and add a call to `registerChannelsListenCommand(channels)`:

```typescript
import { registerChannelsListenCommand } from './channels-listen/index.js';

// Inside the existing function that builds the `channels` parent:
const channels = program.command('channels').description('Manage WhatsApp channels');
// ... existing subcommands (list, etc.) ...
registerChannelsListenCommand(channels);
```

No changes to `src/index.ts` — the existing wiring of `channels.ts` into root commander already covers the new subcommand.

- [ ] **Step 5: Smoke build**

```bash
pnpm build 2>&1 | tail -20
```

Expected: no TS errors.

- [ ] **Step 6: Manual local smoke**

Against a local backend that has the monorepo changes (Tasks 1–14 of the monorepo plan):

```bash
pnpm exec tsx src/index.ts channels listen --help
pnpm exec tsx src/index.ts channels --help
```

Expected: `channels listen --help` shows the new command + flags + description. `channels --help` lists `listen` alongside the existing channels subcommands.

- [ ] **Step 7: Commit**

```bash
git add src/commands/channels.ts src/commands/channels-listen/
git commit -m "feat(cli): hookmyapp channels listen — real-channel CLI tunnel command"
```

---

## Task 5: PostHog observability — typed event registry

**Files:**
- Modify: `/Users/ordvir/COD/cli/src/analytics/events.ts` — CLI's typed event registry
- Modify: `/Users/ordvir/COD/hookmyapp/packages/observability/src/analytics/events.ts` — monorepo's matching superset (the cross-repo drift test referenced at the top of `cli/src/analytics/events.ts` asserts CLI's manifest is a structural subset of monorepo's)

**Why:** The CLI's typed event registry at `src/analytics/events.ts` declares exactly the events the CLI emits. Task 4 added emit calls for two events — `cli_channel_listen_started` and `cli_channel_listen_stopped`. Per the file's invariant: "every event declared here must exist in the monorepo with the same property set." So we add the types to BOTH registries.

Three new events, mirroring the existing `cli_sandbox_listen_*` shape:
- `cli_channel_listen_started` — fires once after tunnel up + heartbeat running
- `cli_channel_listen_stopped` — fires on clean exit (SIGINT/SIGTERM or 410 reclaim); carries `duration_seconds`
- `cli_channel_listen_liveness` — 2h coarse backstop ping (parallel to `cli_sandbox_listen_liveness`)

- [ ] **Step 1: Add the three TypeScript interfaces in the CLI registry**

In `/Users/ordvir/COD/cli/src/analytics/events.ts`, alongside `CliSandboxListenStartedProps` / `CliSandboxListenLivenessProps` / `CliSandboxListenStoppedProps`:

```typescript
export interface CliChannelListenStartedProps {
  cli_version: string;
  channel_public_id: string;
  workspace_public_id: string;
}

export interface CliChannelListenLivenessProps {
  cli_version: string;
  channel_public_id: string;
  elapsed_seconds: number;
}

export interface CliChannelListenStoppedProps {
  cli_version: string;
  channel_public_id: string;
  duration_seconds: number;
}
```

Add them to whatever union/map the file uses to dispatch event names → prop types. Read the bottom of the file for the existing union; mirror its shape.

- [ ] **Step 2: Mirror in the monorepo registry**

In `/Users/ordvir/COD/hookmyapp/packages/observability/src/analytics/events.ts`, add the same three interfaces with matching property shapes. The cross-repo drift test
(`packages/observability/src/analytics/__tests__/manifest-drift.spec.ts`) asserts CLI's manifest is a STRUCTURAL SUBSET of the monorepo's — adding to monorepo first (or in lock-step) keeps the test green.

This step lands in the MONOREPO. Schedule as a small companion PR alongside the CLI release; merge ordering is: monorepo merge → CLI release.

- [ ] **Step 3: Run both registries' tests**

```bash
# In the CLI repo:
cd /Users/ordvir/COD/cli && pnpm test -- analytics --reporter=verbose

# In the monorepo:
cd /Users/ordvir/COD/hookmyapp && pnpm --filter @hookmyapp/observability test -- manifest-drift --reporter=verbose
```

Both: PASS.

- [ ] **Step 4: Commit (both repos)**

CLI:
```bash
cd /Users/ordvir/COD/cli
git add src/analytics/events.ts
git commit -m "feat(cli): register cli_channel_listen_{started,liveness,stopped} typed events"
```

Monorepo (companion PR):
```bash
cd /Users/ordvir/COD/hookmyapp
git add packages/observability/src/analytics/events.ts
git commit -m "observability: add cli_channel_listen_* event types for CLI 0.12.0"
```

---

## Task 6: Top-level wizard menu — "Listen on a real channel" branch

**Files:**
- Modify: `/Users/ordvir/COD/cli/src/auth/login.ts` (or wherever the no-arg `hookmyapp` flow lives — find via `grep -n "runSandboxFlow\|runSandboxWizard" src/auth/login.ts`)

**Why:** When the user runs `hookmyapp` with no args, today they drop into a sandbox wizard. Spec says: add a menu at that level letting them pick between "Try the sandbox" and "Listen on a real channel". Real-channel branch requires they have ≥1 forwarding-enabled channel; otherwise show a "Connect a WhatsApp number first" hint.

- [ ] **Step 1: Find the entry point**

```bash
grep -nE "runSandboxFlow|wizard|main.*async" /Users/ordvir/COD/cli/src/auth/login.ts | head
```

- [ ] **Step 2: Add the menu**

Inside the no-arg flow, before the existing `runSandboxFlow` call, fetch channels and branch:

```typescript
const channels = await apiClient('/meta/channels', { workspaceId }) as Array<{ publicId: string; forwardingEnabled: boolean }>;
const hasEligible = channels.some((c) => c.forwardingEnabled);

const mode = hasEligible
  ? await select({
      message: 'What would you like to do?',
      choices: [
        { value: 'sandbox', name: 'Try the sandbox (shared WhatsApp number)' },
        { value: 'channel', name: 'Listen on a real channel (HookMyAppCLI)' },
      ],
    })
  : 'sandbox';

if (mode === 'channel') {
  const channel = await pickChannel(channels as Channel[], {});
  await runChannelListenFlow(channel, { /* port, path defaults */ });
  return;
}
// else: existing sandbox flow
await runSandboxFlow(/* existing args */);
```

(Import `runChannelListenFlow` — extract the core of Task 4's action handler into a reusable `runChannelListenFlow(channel, opts)` function alongside `runSandboxFlow`. Same pattern sandbox-listen uses.)

- [ ] **Step 3: Test the branching manually**

```bash
pnpm exec tsx src/index.ts
```

- With a workspace that has no forwarding-enabled channels: should drop straight into sandbox.
- With a workspace that has ≥1: should show the 2-option menu.

- [ ] **Step 4: Commit**

```bash
git add src/auth/login.ts src/commands/channels-listen/index.ts
git commit -m "feat(cli): wizard menu — sandbox vs `channels listen` branching"
```

---

## Task 7: CLI integration test for `channels listen` flow

**Files:**
- Create: `/Users/ordvir/COD/cli/test-integration/specs/channel-listen.spec.ts`

**Why:** End-to-end coverage using the backend's existing `HOOKMYAPP_E2E_FAKE_TUNNEL` escape hatch (already in place for sandbox-listen integration tests — see `sandbox-listen.spec.ts`). The escape hatch synthesizes tunnel-start/configure/stop responses so the test doesn't mint real Cloudflare resources per run.

- [ ] **Step 1: Read the sandbox integration test for reference**

```bash
cat /Users/ordvir/COD/cli/test-integration/specs/sandbox-listen.spec.ts
```

Note the setup: spawn the CLI subprocess, intercept HTTP via the local backend, assert on stdout + exit code.

- [ ] **Step 2: Write the channel-listen spec**

```typescript
import { describe, test, expect } from 'vitest';
import { spawnCli, /* other helpers from sandbox-listen spec */ } from './_helpers';

describe('hookmyapp channels listen (integration)', () => {
  test('When a forwarding-enabled channel exists and --channel matches, then provisions tunnel, runs heartbeat, exits cleanly on Ctrl-C', async () => {
    /* arrange: seed a channel + forwarding-enabled webhookConfig in the test DB */
    process.env.HOOKMYAPP_E2E_FAKE_TUNNEL = '1';

    const cli = spawnCli(['channels', 'listen', '--channel', 'ch_test1234', '--port', '3001', '--path', '/webhook'], {
      env: { HOOKMYAPP_E2E_FAKE_TUNNEL: '1' /* other env */ },
    });

    /* wait for "Tunnel up" in stdout */
    await cli.waitForStdout(/Tunnel up at /);

    /* send SIGINT */
    cli.kill('SIGINT');
    const { code } = await cli.waitForExit();
    expect(code).toBe(0);
  });

  test('When --channel does not exist, then exits 2 with helpful error', async () => {
    const cli = spawnCli(['channels', 'listen', '--channel', 'ch_aaaaaaa1']);
    const { code, stderr } = await cli.waitForExit();
    expect(code).toBe(2);
    expect(stderr).toMatch(/not found/i);
  });

  test('When backend returns 410 CHANNEL_TUNNEL_RECLAIMED on heartbeat, then exits 0 with userMessage printed', async () => {
    /* arrange: HOOKMYAPP_E2E_FAKE_TUNNEL='1' AND a per-test env var that makes the fake backend return 410 on heartbeat */
    const cli = spawnCli(['channels', 'listen', '--channel', 'ch_test1234'], {
      env: { HOOKMYAPP_E2E_FAKE_TUNNEL: '1', HOOKMYAPP_E2E_FAKE_HEARTBEAT_410: '1' },
    });
    const { code, stdout } = await cli.waitForExit();
    expect(code).toBe(0);
    expect(stdout).toMatch(/destination was changed/i);
  });
});
```

(If `HOOKMYAPP_E2E_FAKE_HEARTBEAT_410` doesn't exist, add it to the backend's existing fake-tunnel logic — but per `feedback_minimum_viable_integration`, the simpler approach is to have the integration test directly mutate the DB during the run to clear the tunnel fields, triggering a real 410 from the unmodified backend. Pick whichever requires less backend-side change.)

- [ ] **Step 3: Run the integration test**

```bash
pnpm test:integration -- channel-listen --reporter=verbose
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add test-integration/specs/channel-listen.spec.ts
git commit -m "test(cli): integration coverage for `channels listen` flow"
```

---

## Task 8: README + CHANGELOG

**Files:**
- Modify: `/Users/ordvir/COD/cli/README.md`
- Modify: `/Users/ordvir/COD/cli/CHANGELOG.md`

**Why:** New surface needs to be documented for npm consumers. The README's command-reference section gains a `channels listen` entry; CHANGELOG records the 0.12.0 release.

- [ ] **Step 1: Add CHANGELOG entry**

At the top of `CHANGELOG.md`:

```markdown
## 0.12.0 — 2026-MM-DD

### Added
- `hookmyapp channels listen` — listen for inbound WhatsApp webhooks on a real onboarded channel via a per-channel Cloudflare Tunnel. Same mechanics as `sandbox listen`, but for real numbers. Requires backend version `X.Y.Z` or later (auto-checked on startup).
- Top-level wizard menu offers "Listen on a real channel" branch when the workspace has ≥1 forwarding-enabled channel.
- PostHog events: `cli_channel_listen_started`, `cli_channel_listen_stopped`, `cli_channel_listen_liveness` (parallels the existing `cli_sandbox_listen_*` event shape).
```

- [ ] **Step 2: Add README command-reference entry**

In `README.md`, locate the existing `sandbox listen` section and add a parallel `channels listen` section below:

```markdown
### `hookmyapp channels listen`

Listen for inbound WhatsApp messages on one of your real onboarded channels. The CLI provisions a temporary Cloudflare Tunnel and pipes inbound webhooks to your localhost port.

```
hookmyapp channels listen [--channel <publicId>] [--port <port>] [--path <path>]
```

When the CLI is running, the channel's destination shows as **HookMyAppCLI** in the dashboard. Stop with Ctrl-C — your channel's destination returns to its default (HookMyAppCLI awaiting a CLI, or your previously-configured webhook URL if one was set).

If you set a webhook URL in the dashboard while the CLI is running, the CLI exits cleanly with a notice — the URL wins.

(See the sandbox-listen section above for the full set of flags; they're the same.)
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(cli): README + CHANGELOG for 0.12.0 channel-listen"
```

---

## Task 9: Release 0.12.0

**Files:**
- None (operational).

**Why:** Cut the npm release. Per the existing CLI release flow (sigstore provenance from public repo on github-hosted runner per memory `feedback_npm_provenance_requires_public_repo`).

- [ ] **Step 1: Verify all tests green**

```bash
pnpm test
pnpm test:integration
```

Both: PASS.

- [ ] **Step 2: Push to main and trigger release**

```bash
git push origin main
```

(The CLI repo's release pipeline likely fires on tag-push or on a release-please PR merge — follow whatever pattern exists. If it's tag-push:)

```bash
git tag v0.12.0
git push origin v0.12.0
```

- [ ] **Step 3: Verify the npm publish completed with provenance**

```bash
npm view @gethookmyapp/cli@0.12.0
```

Expected: shows `0.12.0` with a `provenanceStatements` block.

- [ ] **Step 4: Smoke-test the published package against staging**

```bash
npm install -g @gethookmyapp/cli@0.12.0
hookmyapp --version  # 0.12.0
hookmyapp channels listen --help
```

Expected: help renders. (Don't run a live tunnel without a real channel; pick a test channel in staging if you want to verify end-to-end.)

---

## Self-review

Spec coverage:
- ✅ CLI repo split (spec D-section "Repo boundary"): all tasks land in `/Users/ordvir/COD/cli`.
- ✅ Version pinning (correct direction — new CLI vs old backend): Task 1.
- ✅ Picker (`forwardingEnabled=true` filter): Task 2.
- ✅ Lifecycle 410 CHANNEL_TUNNEL_RECLAIMED handling (D3): Task 3.
- ✅ Command wiring (`channels listen` + 4 endpoints + graceful shutdown): Task 4.
- ✅ PostHog `cli_channel_listen_*` events: Tasks 4 + 5.
- ✅ Wizard menu branch (sandbox vs real channel): Task 6.
- ✅ Integration tests (CLAUDE.md hard rule): Task 7.
- ✅ Docs: Task 8.
- ✅ Release flow + provenance: Task 9.

Hard prerequisite: monorepo plan deployed to staging+prod first. Task 1's min-backend-version pin is the version-enforcement guard.
