// Phase 123 Plan 10 — CLI telemetry consent.
//
// Default: telemetry ON. Industry norm for product CLIs (npm, Next.js, Vercel,
// Homebrew). Users already have an authenticated account with the product;
// this is not opt-in.
//
// Overrides (any ONE disables telemetry for that invocation + persists):
//   1. Env var: HOOKMYAPP_TELEMETRY=off (session-scoped, no file write)
//   2. Command: `hookmyapp config set telemetry off` (persists to config.json)
//
// First-run disclosure: a one-time stderr banner prints the first time the
// CLI runs an authenticated command with telemetry still enabled. The
// `telemetryDisclosureShown` flag in config.json prevents re-printing.
//
// Decision persists in the same `~/.hookmyapp/config.json` the rest of the
// CLI uses (workspace state, env-profile). Respects `HOOKMYAPP_CONFIG_DIR`
// which vitest.setup.ts forks to a tmp dir for test isolation.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function configDir(): string {
  return process.env.HOOKMYAPP_CONFIG_DIR ?? join(homedir(), '.hookmyapp');
}

function configFile(): string {
  return join(configDir(), 'config.json');
}

type TelemetryFlag = 'on' | 'off';

interface Config {
  telemetry?: TelemetryFlag;
  telemetryDisclosureShown?: boolean;
  // Other existing keys (activeWorkspaceId, activeWorkspaceSlug, env, etc.)
  // are preserved by the read+merge+write pattern below.
  [key: string]: unknown;
}

function readConfig(): Config {
  if (!existsSync(configFile())) return {};
  try {
    const parsed = JSON.parse(readFileSync(configFile(), 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

function writeConfig(next: Config): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2));
}

/**
 * Returns true if the CLI should initialize Sentry for this process. Gate
 * order (first match wins):
 *   1. HOOKMYAPP_TELEMETRY=off env → false (no file read, no file write)
 *   2. config.json `telemetry` key → whatever it says
 *   3. Default → true (ON)
 */
export function isTelemetryEnabled(): boolean {
  if (process.env.HOOKMYAPP_TELEMETRY === 'off') return false;
  const cfg = readConfig();
  return cfg.telemetry !== 'off';
}

/** Read the persisted telemetry flag (for `hookmyapp config get telemetry`). */
export function getPersistedTelemetry(): TelemetryFlag | null {
  const cfg = readConfig();
  return cfg.telemetry ?? null;
}

/** Persist telemetry on/off to config.json (merges with other config keys). */
export function setPersistedTelemetry(value: TelemetryFlag): void {
  const cfg = readConfig();
  cfg.telemetry = value;
  writeConfig(cfg);
}

/** Remove the persisted telemetry flag (revert to default — ON). */
export function unsetPersistedTelemetry(): void {
  const cfg = readConfig();
  delete cfg.telemetry;
  writeConfig(cfg);
}

/**
 * Print the first-run disclosure banner to stderr ONCE per installation,
 * persisting `telemetryDisclosureShown: true` so subsequent runs stay quiet.
 *
 * Called from `initSentryLazy()` after Sentry.init succeeds — so the banner
 * only fires when telemetry is actually enabled AND a capture path runs.
 * Users who opt out via HOOKMYAPP_TELEMETRY=off on their first-ever run never
 * see the banner (and don't need to — they already opted out).
 */
export function maybePrintFirstRunDisclosure(): void {
  const cfg = readConfig();
  if (cfg.telemetryDisclosureShown) return;
  process.stderr.write(
    [
      '',
      'ℹ Telemetry: HookMyApp CLI reports crashes + usage analytics to help us fix bugs and improve UX.',
      '  No command arguments, file contents, or env var values are sent.',
      '  Disable: `hookmyapp config set telemetry off` or `HOOKMYAPP_TELEMETRY=off`',
      '',
    ].join('\n'),
  );
  cfg.telemetryDisclosureShown = true;
  writeConfig(cfg);
}
