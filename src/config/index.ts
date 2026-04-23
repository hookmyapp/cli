// Phase 125 Plan 02 — PostHog-related config slice.
//
// `~/.hookmyapp/config.json` is the shared on-disk store the CLI uses for
// every persistent setting (workspace state, env profile, telemetry consent,
// disclosure shown). This module owns the PostHog-only keys + reuses the
// merge-read-then-write pattern that `commands/workspace.ts` and
// `config/env-profiles.ts` already establish. Why a separate module:
//
//   1. Keeps the existing files (workspace, env-profiles, telemetry) at the
//      shape they shipped with — no risk of clobbering their own slices.
//   2. Single import surface for the PostHog wiring (posthog.ts, login.ts,
//      index.ts entry, sandbox-listen lifecycle) → `import {…} from
//      '../config/index.js'` reads cleanly and matches the plan's
//      <files_modified> list.
//   3. CONTEXT.md §3 + §16 require these keys to be persistent + shared
//      across multiple call sites — a module dedicated to them prevents
//      accidental shape drift.
//
// All reads + writes are merge-aware (read full file → set our keys → write
// full file) so we never trample the workspace / env / telemetry slices.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function configDir(): string {
  return process.env.HOOKMYAPP_CONFIG_DIR ?? join(homedir(), '.hookmyapp');
}

function configFile(): string {
  return join(configDir(), 'config.json');
}

/**
 * The full on-disk config shape — narrow type for the keys this module reads /
 * writes; everything else is preserved verbatim through the merge round-trip
 * (the `[key: string]: unknown` index lets the workspace + env + telemetry
 * slices flow through untouched).
 *
 * KEY OWNERSHIP MAP (source of truth for who writes what):
 *   - activeWorkspaceId / activeWorkspaceSlug  → commands/workspace.ts
 *   - env                                       → config/env-profiles.ts
 *   - telemetry / telemetryDisclosureShown      → observability/telemetry.ts
 *   - posthogDistinctId / posthogAliasedUsers / lastWorkosSub / signupDate
 *                                               → THIS MODULE (config/index.ts)
 */
export interface PosthogConfigSlice {
  /**
   * Stable per-installation UUID generated lazily on the first PostHog need
   * (CONTEXT.md §3 — anonymous distinct_id for pre-login captures). Persists
   * forever once written so multi-day installs stay attributable.
   */
  posthogDistinctId?: string;
  /**
   * WorkOS subs that have been aliased to `posthogDistinctId` on THIS machine
   * (CONTEXT.md §3 — once-per-(machine,user) alias semantics). Repeated
   * logins for an already-aliased sub skip the alias call; logins for a new
   * sub on the same machine still alias once for that pair.
   */
  posthogAliasedUsers?: string[];
  /**
   * Last successfully-resolved WorkOS sub (set after every login). Used as
   * the runtime `distinctId` so post-login emits land on the user profile
   * the app + marketing already populated, not the anonymous machine.
   */
  lastWorkosSub?: string;
  /**
   * ISO-8601 UTC date the workspace owner signed up. Used to compute
   * `days_since_signup` baseline property (CONTEXT.md §16). Optional —
   * `null` baseline value when missing. Future plan can populate this from
   * a backend call; today we leave it unset and accept the null.
   */
  signupDate?: string;
}

interface FullConfig extends PosthogConfigSlice {
  [key: string]: unknown;
}

function readFullConfig(): FullConfig {
  if (!existsSync(configFile())) return {};
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as FullConfig) : {};
  } catch {
    return {};
  }
}

function writeFullConfig(next: FullConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2));
}

/** Read-only snapshot of the PostHog slice (callers ignore other keys). */
export function readPosthogConfig(): PosthogConfigSlice {
  const cfg = readFullConfig();
  return {
    posthogDistinctId: cfg.posthogDistinctId,
    posthogAliasedUsers: cfg.posthogAliasedUsers,
    lastWorkosSub: cfg.lastWorkosSub,
    signupDate: cfg.signupDate,
  };
}

/**
 * Merge-write the PostHog slice. Any key not present in `slice` is left
 * untouched; passing `undefined` for a key explicitly removes it.
 *
 * Other slices (workspace, env, telemetry) are preserved verbatim — the
 * read-modify-write round-trip is the cross-module contract that prevents
 * the file from being clobbered.
 */
export function writePosthogConfig(slice: Partial<PosthogConfigSlice>): void {
  const cfg = readFullConfig();
  for (const [k, v] of Object.entries(slice)) {
    if (v === undefined) {
      delete (cfg as Record<string, unknown>)[k];
    } else {
      (cfg as Record<string, unknown>)[k] = v;
    }
  }
  writeFullConfig(cfg);
}

/**
 * Read the active workspace publicId (`ws_…`) for use as the `workspace_id`
 * baseline property. Returns `undefined` when not yet resolved (pre-login or
 * pre-`workspace use`). The full readWorkspaceConfig() lives in
 * commands/workspace.ts; we duplicate the read here to avoid a new import
 * cycle (commands/workspace.ts → api/client.ts → … → posthog.ts → config).
 */
export function readActiveWorkspacePublicId(): string | undefined {
  const cfg = readFullConfig();
  const id = cfg.activeWorkspaceId;
  return typeof id === 'string' && id.startsWith('ws_') ? id : undefined;
}
