// Update-available banner (AIT-24) — mirrors the Codex CLI behavior: every
// command surfaces a one-shot notice on stderr when a newer npm version
// exists. The version check itself is delegated to `update-notifier`, which
// runs it in a DETACHED child process with a ~24h cache, so it can never add
// latency to, block, or crash the actual command (fail-open by design).
//
// Runtime-safety guardrails (recorded on AIT-24, 2026-07-09) — the banner
// must never disturb a long-running process (`channels listen` tunnel,
// `sandbox listen`, `logs --follow` streams):
//
//   1. stderr ONLY — stdout carries tunnel payloads and --json/JSONL.
//   2. Once, at boot, before any command loop — never injected mid-stream.
//   3. Skipped entirely when non-interactive or --json (agents, CI, pipes).
//   4. Passive notice only — never auto-updates, restarts, or signals.
//
// `update-notifier` additionally honors NO_UPDATE_NOTIFIER, --no-update-notifier,
// NODE_ENV=test, and CI detection on its own check side.

import process from 'node:process';

export interface UpdateInfo {
  current: string;
  latest: string;
}

export interface BannerEnv {
  isTTY: boolean;
  argv: string[];
  ci: boolean;
  currentVersion: string;
  update: UpdateInfo | undefined;
}

/** Pure gate — all guardrails in one testable place. */
export function shouldShowUpdateBanner(env: BannerEnv): boolean {
  if (!env.isTTY) return false; // rule 3: pipes, agents, redirected stderr
  if (env.ci) return false; // rule 3: CI runners
  if (env.argv.includes('--json')) return false; // rule 3: machine output
  if (!env.update) return false; // no (cached) update known
  // Just-upgraded case: the cache can still hold last run's update info.
  // ponytail: exact-match guard only — a "current newer than latest" state
  // only occurs on unpublished dev builds, and the cache expires in ~24h.
  if (env.update.latest === env.currentVersion) return false;
  return true;
}

/** Codex-style banner (ticket AIT-24 desired format). */
export function renderUpdateBanner(update: UpdateInfo): string {
  return [
    '',
    `  ✨ Update available! ${update.current} -> ${update.latest}`,
    '',
    '  Release notes: https://github.com/hookmyapp/cli/releases/latest',
    '  Run npm install -g @gethookmyapp/cli to update',
    '',
    '',
  ].join('\n');
}

/**
 * Boot hook — call once from main() before the command runs. Reads the
 * cached check result (previous run's detached child) and kicks off a cache
 * refresh for the next run. Never throws.
 */
export async function maybeNotifyUpdate(currentVersion: string): Promise<void> {
  try {
    const { default: updateNotifier } = await import('update-notifier');
    const notifier = updateNotifier({
      pkg: { name: '@gethookmyapp/cli', version: currentVersion },
    });
    const env: BannerEnv = {
      isTTY: Boolean(process.stderr.isTTY),
      argv: process.argv,
      ci: Boolean(process.env.CI),
      currentVersion,
      update: notifier.update
        ? { current: notifier.update.current, latest: notifier.update.latest }
        : undefined,
    };
    if (shouldShowUpdateBanner(env)) {
      process.stderr.write(renderUpdateBanner(env.update!));
    }
  } catch {
    // The update check must NEVER break or slow a real command. Same
    // fail-open policy as the telemetry + migration calls in index.ts.
  }
}
