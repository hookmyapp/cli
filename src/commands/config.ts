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

/**
 * `hookmyapp config` — manage persistent CLI settings. Currently supports
 * the environment profile (local | staging | production) that URL resolution
 * and the WorkOS client id follow.
 */
export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage persistent CLI settings (environment profile, etc.)');

  addExamples(
    config,
    `
EXAMPLES:
  $ hookmyapp config show                    # print active env + resolved URLs
  $ hookmyapp config set env staging         # persist staging as active env
  $ hookmyapp config get env                 # print persisted env
  $ hookmyapp config unset env               # revert to default (production)
`,
  );

  function isJsonMode(cmd: Command): boolean {
    return !!cmd.optsWithGlobals().json;
  }

  // --- config set ---
  const set = config
    .command('set <key> <value>')
    .description('Set a persistent config value')
    .action(function (this: Command, key: string, value: string) {
      if (key !== 'env') {
        throw new ValidationError(`Unknown config key "${key}". Valid keys: env.`);
      }
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
    });

  addExamples(
    set,
    `
EXAMPLES:
  $ hookmyapp config set env production
  $ hookmyapp config set env staging
  $ hookmyapp config set env local
`,
  );

  // --- config get ---
  const get = config
    .command('get <key>')
    .description('Print a persistent config value')
    .action(function (this: Command, key: string) {
      if (key !== 'env') {
        throw new ValidationError(`Unknown config key "${key}". Valid keys: env.`);
      }
      const persisted = getPersistedEnv();
      const active = resolveEnv();
      if (isJsonMode(this)) {
        console.log(
          JSON.stringify({ key, value: persisted ?? null, active, default: DEFAULT_ENV }),
        );
      } else if (persisted) {
        console.log(persisted);
      } else {
        console.log(`${active} (default — no value persisted)`);
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
      if (key !== 'env') {
        throw new ValidationError(`Unknown config key "${key}". Valid keys: env.`);
      }
      unsetPersistedEnv();
      if (isJsonMode(this)) {
        console.log(JSON.stringify({ key, unset: true, default: DEFAULT_ENV }));
      } else {
        console.log(`✓ env unset (defaults to ${DEFAULT_ENV})`);
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

      if (isJsonMode(this)) {
        console.log(
          JSON.stringify(
            {
              env,
              source,
              apiUrl: apiOverride ?? profile.apiUrl,
              appUrl: appOverride ?? profile.appUrl,
              workosClientId: workosOverride ?? profile.workosClientId,
              overrides: {
                apiUrl: apiOverride ?? null,
                appUrl: appOverride ?? null,
                workosClientId: workosOverride ?? null,
              },
            },
            null,
            2,
          ),
        );
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
