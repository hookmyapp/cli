import fs from 'node:fs';
import { isValidPublicId } from '../lib/publicId.js';
import { getConfigFile, safeWriteFileSync } from '../storage/path.js';
import { ConfigurationError } from '../output/error.js';

export type EnvName = 'local' | 'staging' | 'production';

export interface EnvProfile {
  apiUrl: string;
  appUrl: string;
  workosClientId: string;
  // 12-digit (or 11-digit NANP) E.164 number sans '+' that the CLI shows in
  // `sandbox start` output as the WhatsApp destination for the bind code.
  // Per-env: each env runs an isolated sandbox WABA under a separate Meta App
  // (staging IL, prod US). NEVER cross over.
  sandboxWhatsAppNumber: string;
  // Base URL for the Meta gateway proxy — customers append the verbatim Graph
  // path, e.g. `${gatewayUrl}/v22.0/{phone_number_id}/messages`.
  gatewayUrl: string;
}

/**
 * Built-in environment profiles. The production profile is the default for
 * any `@gethookmyapp/cli` installation; local and staging are opt-in via
 * `hookmyapp config set env <name>` or the `--env` flag.
 *
 * See CLAUDE.md for the ngrok-app tunnel that backs "local" — the dev's
 * compose stack must be running for that profile to work.
 */
export const ENV_PROFILES: Record<EnvName, EnvProfile> = {
  local: {
    apiUrl: 'https://uninked-robbi-boughless.ngrok-free.dev',
    appUrl: 'https://uninked-robbi-boughless.ngrok-free.dev',
    workosClientId: 'client_01KPB6HCD7Q26ATBM9ZNKX97GD',
    // local dev shares the staging sandbox WABA (+972 55 704 6276)
    sandboxWhatsAppNumber: '972557046276',
    gatewayUrl: 'http://localhost:4317/meta',
  },
  staging: {
    apiUrl: 'https://staging-api.hookmyapp.com',
    appUrl: 'https://staging-app.hookmyapp.com',
    workosClientId: 'client_01KM5S4CGX9M2M2P63JTA6AFEH',
    // staging sandbox WABA: +972 55 704 6276 (WABA 1276334778010256)
    sandboxWhatsAppNumber: '972557046276',
    gatewayUrl: 'https://staging-gateway.hookmyapp.com/meta',
  },
  production: {
    apiUrl: 'https://api.hookmyapp.com',
    appUrl: 'https://app.hookmyapp.com',
    workosClientId: 'client_01KM5S4D10TKG4VJEXSCRVAMG7',
    // prod sandbox WABA: +1 737-237-0900 (WABA 1703736267434336) — separate
    // Meta App from staging; do NOT use the IL number here.
    sandboxWhatsAppNumber: '17372370900',
    gatewayUrl: 'https://gateway.hookmyapp.com/meta',
  },
};

export const DEFAULT_ENV: EnvName = 'production';
export const VALID_ENV_NAMES = Object.keys(ENV_PROFILES) as EnvName[];

export function isValidEnv(name: string): name is EnvName {
  return (VALID_ENV_NAMES as string[]).includes(name);
}

interface PersistedConfig {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
  env?: EnvName;
  defaultChannel?: string; // ch_ publicId
}

function readConfig(): PersistedConfig {
  try {
    return JSON.parse(fs.readFileSync(getConfigFile(), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Return the persisted `activeWorkspaceId` IF AND ONLY IF it is a valid
 * ws_ publicId (post-Phase-117 shape). A stored value from a pre-0.5.0 CLI
 * (raw UUID) is silently dropped — callers see `undefined` and re-resolve
 * via the single-workspace auto-pick path in `_helpers.getDefaultWorkspaceId`
 * or the login wizard, identical to how a fresh install behaves. This
 * preserves the ~/.hookmyapp/config.json file (so the `env` slice owned by
 * this module is not clobbered) while keeping the CLI's wire traffic
 * publicId-only — ensuring a stale UUID value never escapes to the backend.
 */
export function getValidPersistedWorkspaceId(): string | undefined {
  const cfg = readConfig();
  if (cfg.activeWorkspaceId && isValidPublicId(cfg.activeWorkspaceId, 'ws')) {
    return cfg.activeWorkspaceId;
  }
  return undefined;
}

function writeConfig(cfg: PersistedConfig): void {
  safeWriteFileSync(getConfigFile(), JSON.stringify(cfg, null, 2) + '\n');
}

export function getPersistedEnv(): EnvName | undefined {
  const cfg = readConfig();
  if (cfg.env && isValidEnv(cfg.env)) return cfg.env;
  return undefined;
}

export function setPersistedEnv(env: EnvName): void {
  const cfg = readConfig();
  cfg.env = env;
  writeConfig(cfg);
}

export function unsetPersistedEnv(): void {
  const cfg = readConfig();
  delete cfg.env;
  writeConfig(cfg);
}

/**
 * Persisted default channel (D6). Stored as a `ch_` publicId only — a stale or
 * malformed value is silently dropped (callers see `undefined` and must pass
 * `--channel`). Mirrors the validate-on-read posture of
 * {@link getValidPersistedWorkspaceId}.
 */
export function getPersistedDefaultChannel(): string | undefined {
  const cfg = readConfig();
  return cfg.defaultChannel && isValidPublicId(cfg.defaultChannel, 'ch')
    ? cfg.defaultChannel
    : undefined;
}

export function setPersistedDefaultChannel(channelId: string): void {
  if (!isValidPublicId(channelId, 'ch')) {
    throw new ConfigurationError(
      `Default channel must be a ch_ publicId, got "${channelId}".`,
      'INVALID_DEFAULT_CHANNEL',
    );
  }
  const cfg = readConfig();
  cfg.defaultChannel = channelId;
  writeConfig(cfg);
}

export function unsetPersistedDefaultChannel(): void {
  const cfg = readConfig();
  delete cfg.defaultChannel;
  writeConfig(cfg);
}

/**
 * Resolve the active env profile. Precedence:
 *   1. `HOOKMYAPP_ENV` env var (set by Commander --env flag handler OR caller)
 *   2. `config.json` "env" field
 *   3. DEFAULT_ENV ("production")
 *
 * The individual env vars `HOOKMYAPP_API_URL`, `HOOKMYAPP_APP_URL`, and
 * `HOOKMYAPP_WORKOS_CLIENT_ID` are NOT consulted here — they are surgical
 * overrides applied by the consumers via `getEffective*()`.
 */
export function resolveEnv(): EnvName {
  const candidate = process.env.HOOKMYAPP_ENV ?? getPersistedEnv() ?? DEFAULT_ENV;
  if (!isValidEnv(candidate)) {
    throw new ConfigurationError(
      `Invalid env "${candidate}". Valid values: ${VALID_ENV_NAMES.join(', ')}.`,
      'INVALID_ENV',
    );
  }
  return candidate;
}

export function resolveEnvProfile(): EnvProfile {
  return ENV_PROFILES[resolveEnv()];
}

/**
 * Effective URLs/client-id after applying surgical overrides. Consumers
 * should call these once per invocation rather than rolling their own `??`
 * chains against `process.env`.
 */
export function getEffectiveApiUrl(): string {
  return process.env.HOOKMYAPP_API_URL ?? resolveEnvProfile().apiUrl;
}

export function getEffectiveAppUrl(): string {
  return process.env.HOOKMYAPP_APP_URL ?? resolveEnvProfile().appUrl;
}

export function getEffectiveWorkosClientId(): string {
  return process.env.HOOKMYAPP_WORKOS_CLIENT_ID ?? resolveEnvProfile().workosClientId;
}

/**
 * API base URL for the bootstrap-code exchange (`login --code`). A bootstrap
 * code is minted for ONE specific backend, so a persisted `config.json` env
 * (the user's "default backend" preference) must never silently redirect a
 * pasted code to the wrong `/auth/bootstrap/exchange`. We therefore skip
 * `getPersistedEnv()` here and honor only an EXPLICIT override — the surgical
 * `HOOKMYAPP_API_URL`, or `HOOKMYAPP_ENV` (set by the `--env` flag handler) —
 * otherwise force production. This is what lets the customer-facing
 * `hookmyapp login --code …` instruction omit `--env` and still always reach
 * production, even on a machine where `config set env staging` was once run.
 */
export function getBootstrapApiUrl(): string {
  if (process.env.HOOKMYAPP_API_URL) return process.env.HOOKMYAPP_API_URL;
  return ENV_PROFILES[resolveBootstrapEnvName()].apiUrl;
}

/**
 * The env name for the non-explicit-URL bootstrap path: `HOOKMYAPP_ENV` →
 * DEFAULT_ENV (production). Always non-null. Deliberately skips
 * `getPersistedEnv()` (see getBootstrapApiUrl).
 */
function resolveBootstrapEnvName(): EnvName {
  const candidate = process.env.HOOKMYAPP_ENV ?? DEFAULT_ENV;
  if (!isValidEnv(candidate)) {
    throw new ConfigurationError(
      `Invalid env "${candidate}". Valid values: ${VALID_ENV_NAMES.join(', ')}.`,
      'INVALID_ENV',
    );
  }
  return candidate;
}

/**
 * The EnvName the bootstrap-code exchange resolves against, using the same
 * precedence as {@link getBootstrapApiUrl} MINUS the surgical
 * `HOOKMYAPP_API_URL` (which is a raw URL with no env name): `HOOKMYAPP_ENV`
 * → DEFAULT_ENV (production). Deliberately skips `getPersistedEnv()` for the
 * same reason getBootstrapApiUrl does.
 *
 * The caller (`runBootstrapCodeExchange`) persists this AFTER a successful
 * exchange so the post-login wizard's `/workspaces` call — and every future
 * command — resolves to the SAME backend the code was minted for. Without it,
 * a stale `config set env staging` silently routes a prod-minted session's
 * follow-up calls to staging, 401-ing a production token (the WorkOS envs are
 * separate). Returns null only for the explicit-URL override, where there's
 * no env name to persist.
 */
export function getBootstrapEnv(): EnvName | null {
  if (process.env.HOOKMYAPP_API_URL) {
    const match = (
      Object.entries(ENV_PROFILES) as [EnvName, EnvProfile][]
    ).find(([, p]) => p.apiUrl === process.env.HOOKMYAPP_API_URL);
    return match ? match[0] : null;
  }
  return resolveBootstrapEnvName();
}

/**
 * Sandbox WhatsApp destination number (digits-only, no '+') the CLI shows in
 * `sandbox start` output for the bind-code WhatsApp deep link. Per-env: each
 * env runs an isolated sandbox WABA under its own Meta App, so the number
 * MUST come from the env profile — staging and prod do not share a number.
 *
 *   local + staging → 972557046276 (+972 55 704 6276)
 *   production      → 17372370900  (+1 737-237-0900)
 *
 * No HOOKMYAPP_SANDBOX_WHATSAPP_NUMBER override on purpose — there's no use
 * case for sending the bind code to anything other than the env's sandbox.
 */
export function getEffectiveSandboxWhatsAppNumber(): string {
  return resolveEnvProfile().sandboxWhatsAppNumber;
}

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

/**
 * Resolve the sandbox-proxy base URL. Mirrors getEffectiveApiUrl() precedence:
 *   1. HOOKMYAPP_SANDBOX_PROXY_URL env var (surgical override for local/CI).
 *   2. Env-profile default:
 *        - local      → http://localhost:4315 (docker-compose sandbox-proxy)
 *        - staging    → https://staging-sandbox.hookmyapp.com
 *        - production → https://sandbox.hookmyapp.com
 *
 * Staging and production target separate Cloud Run services as of Phase 120
 * (each in its own GCP project) AND separate sandbox WABAs under separate
 * Meta Apps: staging proxies to +972 55 704 6276 / WABA 1276334778010256,
 * production proxies to +1 737-237-0900 / WABA 1703736267434336.
 */
/**
 * OPTIONAL surgical override of the gateway base URL (host + /meta + version) for
 * local dev / CI. When unset (the normal case) the base comes from the backend
 * token endpoint (see src/api/gateway.ts), which is env-aware and version-aware —
 * so the CLI never hardcodes a Graph version. When set, this complete base wins
 * verbatim (the dev is responsible for including the right version).
 */
export function getGatewayBaseOverride(): string | undefined {
  const raw = process.env.HOOKMYAPP_GATEWAY_URL;
  return raw ? raw.replace(/\/$/, '') : undefined;
}

export function getEffectiveSandboxProxyUrl(): string {
  const override = process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  if (override) return override.replace(/\/$/, '');
  const env = resolveEnv();
  const byEnv: Record<EnvName, string> = {
    local: 'http://localhost:4315',
    staging: 'https://staging-sandbox.hookmyapp.com',
    production: 'https://sandbox.hookmyapp.com',
  };
  return byEnv[env];
}
