import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type EnvName = 'local' | 'staging' | 'production';

export interface EnvProfile {
  apiUrl: string;
  appUrl: string;
  workosClientId: string;
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
    workosClientId: 'client_01KM5S4CGX9M2M2P63JTA6AFEH',
  },
  staging: {
    apiUrl: 'https://staging-api.hookmyapp.com',
    appUrl: 'https://staging-app.hookmyapp.com',
    workosClientId: 'client_01KM5S4CGX9M2M2P63JTA6AFEH',
  },
  production: {
    apiUrl: 'https://api.hookmyapp.com',
    appUrl: 'https://app.hookmyapp.com',
    workosClientId: 'client_01KM5S4D10TKG4VJEXSCRVAMG7',
  },
};

export const DEFAULT_ENV: EnvName = 'production';
export const VALID_ENV_NAMES = Object.keys(ENV_PROFILES) as EnvName[];

export function isValidEnv(name: string): name is EnvName {
  return (VALID_ENV_NAMES as string[]).includes(name);
}

function configDir(): string {
  return process.env.HOOKMYAPP_CONFIG_DIR ?? path.join(os.homedir(), '.hookmyapp');
}

function configPath(): string {
  return path.join(configDir(), 'config.json');
}

interface PersistedConfig {
  activeWorkspaceId?: string;
  activeWorkspaceSlug?: string;
  env?: EnvName;
}

function readConfig(): PersistedConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg: PersistedConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
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
    throw new Error(
      `Invalid env "${candidate}". Valid values: ${VALID_ENV_NAMES.join(', ')}.`,
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
 * Resolve the sandbox-proxy base URL. Mirrors getEffectiveApiUrl() precedence:
 *   1. HOOKMYAPP_SANDBOX_PROXY_URL env var (surgical override for local/CI).
 *   2. Env-profile default:
 *        - local      → http://localhost:4315 (docker-compose sandbox-proxy)
 *        - staging    → https://sandbox.hookmyapp.com (shared with prod today)
 *        - production → https://sandbox.hookmyapp.com
 *
 * NOTE: staging reuses the prod sandbox-proxy until a dedicated staging
 * sandbox-proxy is deployed. If that changes, update the `byEnv` map below.
 */
export function getEffectiveSandboxProxyUrl(): string {
  const override = process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  if (override) return override.replace(/\/$/, '');
  const env = resolveEnv();
  const byEnv: Record<EnvName, string> = {
    local: 'http://localhost:4315',
    staging: 'https://sandbox.hookmyapp.com',
    production: 'https://sandbox.hookmyapp.com',
  };
  return byEnv[env];
}
