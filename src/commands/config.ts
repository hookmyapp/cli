import type { Command } from 'commander';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import {
  DEFAULT_ENV,
  VALID_ENV_NAMES,
  isValidEnv,
  resolveEnv,
  resolveEnvProfile,
  getPersistedEnv,
  setPersistedEnv,
  unsetPersistedEnv,
} from '../config/env-profiles.js';
import {
  getPersistedTelemetry,
  setPersistedTelemetry,
  unsetPersistedTelemetry,
  isTelemetryEnabled,
} from '../observability/telemetry.js';

const VALID_CONFIG_KEYS = ['env', 'telemetry'] as const;
type ConfigKey = (typeof VALID_CONFIG_KEYS)[number];

function assertConfigKey(key: string): asserts key is ConfigKey {
  if (key !== 'env' && key !== 'telemetry') {
    throw new ValidationError(
      `Unknown config key "${key}". Valid keys: ${VALID_CONFIG_KEYS.join(', ')}.`,
    );
  }
}

/**
 * `hookmyapp config` — manage persistent CLI settings. Currently supports
 * the environment profile (local | staging | production) that URL resolution
 * and the WorkOS client id follow.
 */
export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage persistent CLI settings (telemetry, etc.)');

  addExamples(
    config,
    `
EXAMPLES:
  $ hookmyapp config show                    # print resolved URLs + telemetry state
  $ hookmyapp config set telemetry off       # disable Sentry crash reporting
  $ hookmyapp config set telemetry on        # re-enable crash reporting
  $ hookmyapp config get telemetry           # print persisted telemetry setting
`,
  );

  function isJsonMode(cmd: Command): boolean {
    return !!cmd.optsWithGlobals().json;
  }

  // --- config set ---
  const set = config
    .command('set <key> <value>')
    .description('Set a persistent config value')
    .action(async function (this: Command, key: string, value: string) {
      assertConfigKey(key);
      if (key === 'env') {
        if (!isValidEnv(value)) {
          throw new ValidationError(
            `Invalid env "${value}". Valid values: ${VALID_ENV_NAMES.join(', ')}.`,
          );
        }
        setPersistedEnv(value);
        if (isJsonMode(this)) {
          console.log(JSON.stringify({ key, value }));
        } else {
          console.log(`✓ env set to ${value}`);
        }
        return;
      }
      // key === 'telemetry'
      if (value !== 'on' && value !== 'off') {
        throw new ValidationError(
          `Invalid telemetry value "${value}". Valid values: on, off.`,
        );
      }
      setPersistedTelemetry(value);
      if (isJsonMode(this)) {
        console.log(JSON.stringify({ key, value }));
      } else {
        console.log(`✓ telemetry ${value}`);
      }
    });

  addExamples(
    set,
    `
EXAMPLES:
  $ hookmyapp config set env production
  $ hookmyapp config set env staging
  $ hookmyapp config set env local
  $ hookmyapp config set telemetry off       # disable Sentry crash reporting
  $ hookmyapp config set telemetry on        # re-enable
`,
  );

  // --- config get ---
  const get = config
    .command('get <key>')
    .description('Print a persistent config value')
    .action(function (this: Command, key: string) {
      assertConfigKey(key);
      if (key === 'env') {
        const persisted = getPersistedEnv();
        const active = resolveEnv();
        if (isJsonMode(this)) {
          const out: Record<string, unknown> = { active, default: DEFAULT_ENV };
          if (persisted) out.value = persisted;
          console.log(JSON.stringify(out));
        } else if (persisted) {
          console.log(persisted);
        } else {
          console.log(`${active} (default, no value persisted)`);
        }
        return;
      }
      // key === 'telemetry'
      const persisted = getPersistedTelemetry();
      const active = isTelemetryEnabled() ? 'on' : 'off';
      if (isJsonMode(this)) {
        const out: Record<string, unknown> = { active, default: 'on' };
        if (persisted) out.value = persisted;
        console.log(JSON.stringify(out));
      } else if (persisted) {
        console.log(persisted);
      } else {
        console.log(`${active} (default, no value persisted)`);
      }
    });

  addExamples(
    get,
    `
EXAMPLES:
  $ hookmyapp config get env
  $ hookmyapp config get env --json
`,
  );

  // --- config unset ---
  const unset = config
    .command('unset <key>')
    .description('Remove a persistent config value (revert to default)')
    .action(function (this: Command, key: string) {
      assertConfigKey(key);
      if (key === 'env') {
        unsetPersistedEnv();
        if (isJsonMode(this)) {
          console.log(JSON.stringify({ key, unset: true, default: DEFAULT_ENV }));
        } else {
          console.log(`✓ env unset (defaults to ${DEFAULT_ENV})`);
        }
        return;
      }
      // key === 'telemetry'
      unsetPersistedTelemetry();
      if (isJsonMode(this)) {
        console.log(JSON.stringify({ key, unset: true, default: 'on' }));
      } else {
        console.log('✓ telemetry unset (defaults to on)');
      }
    });

  addExamples(
    unset,
    `
EXAMPLES:
  $ hookmyapp config unset env
  $ hookmyapp config unset env --json
`,
  );

  // --- config show ---
  const show = config
    .command('show')
    .description('Print the active environment profile + resolved URLs')
    .action(function (this: Command) {
      const env = resolveEnv();
      const profile = resolveEnvProfile();
      const persisted = getPersistedEnv();
      const envVarOverride = process.env.HOOKMYAPP_ENV;
      const apiOverride = process.env.HOOKMYAPP_API_URL;
      const appOverride = process.env.HOOKMYAPP_APP_URL;
      const workosOverride = process.env.HOOKMYAPP_WORKOS_CLIENT_ID;

      const source = envVarOverride
        ? 'HOOKMYAPP_ENV'
        : persisted
          ? 'config.json'
          : 'default';

      // Phase 123 Plan 10 — telemetry state appears in `config show` so users
      // have a single authoritative surface to see what's reported.
      const persistedTelemetry = getPersistedTelemetry();
      const telemetryActive = isTelemetryEnabled() ? 'on' : 'off';
      const telemetryEnvOverride = process.env.HOOKMYAPP_TELEMETRY;
      const telemetrySource = telemetryEnvOverride
        ? 'HOOKMYAPP_TELEMETRY'
        : persistedTelemetry
          ? 'config.json'
          : 'default';

      if (isJsonMode(this)) {
        // D7: the JSON `config show` envelope is a frozen {env, telemetry}
        // contract.
        console.log(JSON.stringify({ env, telemetry: telemetryActive }));
      } else {
        console.log(`env:               ${env}`);
        console.log(`  source:          ${source}`);
        console.log(
          `apiUrl:            ${apiOverride ?? profile.apiUrl}${apiOverride ? '  (HOOKMYAPP_API_URL override)' : ''}`,
        );
        console.log(
          `appUrl:            ${appOverride ?? profile.appUrl}${appOverride ? '  (HOOKMYAPP_APP_URL override)' : ''}`,
        );
        console.log(
          `workosClientId:    ${workosOverride ?? profile.workosClientId}${workosOverride ? '  (HOOKMYAPP_WORKOS_CLIENT_ID override)' : ''}`,
        );
        console.log(`telemetry:         ${telemetryActive}`);
        console.log(`  source:          ${telemetrySource}`);
      }
    });

  addExamples(
    show,
    `
EXAMPLES:
  $ hookmyapp config show
  $ hookmyapp config show --json
`,
  );
}
