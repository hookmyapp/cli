import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ENV_PROFILES,
  DEFAULT_ENV,
  VALID_ENV_NAMES,
  isValidEnv,
  resolveEnv,
  resolveEnvProfile,
  getPersistedEnv,
  setPersistedEnv,
  unsetPersistedEnv,
  getEffectiveApiUrl,
  getEffectiveAppUrl,
  getEffectiveWorkosClientId,
} from '../env-profiles.js';

describe('env-profiles: built-in profiles', () => {
  it('defines production as default', () => {
    expect(DEFAULT_ENV).toBe('production');
  });

  it('has exactly three profiles: local, staging, production', () => {
    expect(new Set(VALID_ENV_NAMES)).toEqual(new Set(['local', 'staging', 'production']));
  });

  it('production points at api.hookmyapp.com + app.hookmyapp.com + production WorkOS client', () => {
    expect(ENV_PROFILES.production.apiUrl).toBe('https://api.hookmyapp.com');
    expect(ENV_PROFILES.production.appUrl).toBe('https://app.hookmyapp.com');
    expect(ENV_PROFILES.production.workosClientId).toBe('client_01KM5S4D10TKG4VJEXSCRVAMG7');
  });

  it('staging points at staging-*.hookmyapp.com + staging WorkOS client', () => {
    expect(ENV_PROFILES.staging.apiUrl).toBe('https://staging-api.hookmyapp.com');
    expect(ENV_PROFILES.staging.appUrl).toBe('https://staging-app.hookmyapp.com');
    expect(ENV_PROFILES.staging.workosClientId).toBe('client_01KM5S4CGX9M2M2P63JTA6AFEH');
  });

  it('local uses the ngrok-app tunnel for both api + app, staging WorkOS client', () => {
    expect(ENV_PROFILES.local.apiUrl).toBe('https://uninked-robbi-boughless.ngrok-free.dev');
    expect(ENV_PROFILES.local.appUrl).toBe('https://uninked-robbi-boughless.ngrok-free.dev');
    expect(ENV_PROFILES.local.workosClientId).toBe('client_01KM5S4CGX9M2M2P63JTA6AFEH');
  });

  it('isValidEnv narrows to EnvName for the three valid strings and rejects others', () => {
    expect(isValidEnv('local')).toBe(true);
    expect(isValidEnv('staging')).toBe(true);
    expect(isValidEnv('production')).toBe(true);
    expect(isValidEnv('prod')).toBe(false);
    expect(isValidEnv('')).toBe(false);
    expect(isValidEnv('LOCAL')).toBe(false);
  });
});

// A test sandbox for the config.json persistence — each test gets a fresh tmp dir.
function withTempConfig<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hma-env-profiles-'));
  const origDir = process.env.HOOKMYAPP_CONFIG_DIR;
  const origEnv = process.env.HOOKMYAPP_ENV;
  const origApi = process.env.HOOKMYAPP_API_URL;
  const origApp = process.env.HOOKMYAPP_APP_URL;
  const origWorkos = process.env.HOOKMYAPP_WORKOS_CLIENT_ID;
  process.env.HOOKMYAPP_CONFIG_DIR = dir;
  delete process.env.HOOKMYAPP_ENV;
  delete process.env.HOOKMYAPP_API_URL;
  delete process.env.HOOKMYAPP_APP_URL;
  delete process.env.HOOKMYAPP_WORKOS_CLIENT_ID;
  try {
    return fn(dir);
  } finally {
    if (origDir === undefined) delete process.env.HOOKMYAPP_CONFIG_DIR;
    else process.env.HOOKMYAPP_CONFIG_DIR = origDir;
    if (origEnv === undefined) delete process.env.HOOKMYAPP_ENV;
    else process.env.HOOKMYAPP_ENV = origEnv;
    if (origApi === undefined) delete process.env.HOOKMYAPP_API_URL;
    else process.env.HOOKMYAPP_API_URL = origApi;
    if (origApp === undefined) delete process.env.HOOKMYAPP_APP_URL;
    else process.env.HOOKMYAPP_APP_URL = origApp;
    if (origWorkos === undefined) delete process.env.HOOKMYAPP_WORKOS_CLIENT_ID;
    else process.env.HOOKMYAPP_WORKOS_CLIENT_ID = origWorkos;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('env-profiles: resolution precedence', () => {
  it('returns production when nothing is set', () => {
    withTempConfig(() => {
      expect(resolveEnv()).toBe('production');
    });
  });

  it('reads from config.json when persisted', () => {
    withTempConfig(() => {
      setPersistedEnv('staging');
      expect(resolveEnv()).toBe('staging');
    });
  });

  it('HOOKMYAPP_ENV beats config.json', () => {
    withTempConfig(() => {
      setPersistedEnv('staging');
      process.env.HOOKMYAPP_ENV = 'local';
      expect(resolveEnv()).toBe('local');
    });
  });

  it('throws on an invalid HOOKMYAPP_ENV value', () => {
    withTempConfig(() => {
      process.env.HOOKMYAPP_ENV = 'prod';
      expect(() => resolveEnv()).toThrow(/Invalid env "prod"/);
    });
  });
});

describe('env-profiles: persistence round-trip', () => {
  it('setPersistedEnv + getPersistedEnv round-trip', () => {
    withTempConfig(() => {
      expect(getPersistedEnv()).toBeUndefined();
      setPersistedEnv('staging');
      expect(getPersistedEnv()).toBe('staging');
      setPersistedEnv('local');
      expect(getPersistedEnv()).toBe('local');
    });
  });

  it('unsetPersistedEnv removes only the env field, leaving other keys intact', () => {
    withTempConfig((dir) => {
      // Pre-seed with another field that config.ts owners (workspace.ts) write.
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ activeWorkspaceId: 'ws_1', env: 'staging' }),
      );
      unsetPersistedEnv();
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
      expect(raw).toEqual({ activeWorkspaceId: 'ws_1' });
    });
  });

  it('ignores corrupt config.json (treats as no persistence)', () => {
    withTempConfig((dir) => {
      fs.writeFileSync(path.join(dir, 'config.json'), 'not valid json');
      expect(getPersistedEnv()).toBeUndefined();
      expect(resolveEnv()).toBe('production');
    });
  });
});

describe('env-profiles: effective URLs + WorkOS id', () => {
  it('uses profile values when no overrides set', () => {
    withTempConfig(() => {
      setPersistedEnv('staging');
      expect(getEffectiveApiUrl()).toBe('https://staging-api.hookmyapp.com');
      expect(getEffectiveAppUrl()).toBe('https://staging-app.hookmyapp.com');
      expect(getEffectiveWorkosClientId()).toBe('client_01KM5S4CGX9M2M2P63JTA6AFEH');
    });
  });

  it('surgical env vars override individual resolved values without switching profile', () => {
    withTempConfig(() => {
      setPersistedEnv('production');
      process.env.HOOKMYAPP_API_URL = 'http://localhost:4312';
      expect(getEffectiveApiUrl()).toBe('http://localhost:4312');
      // appUrl + workos client id still follow production profile
      expect(getEffectiveAppUrl()).toBe('https://app.hookmyapp.com');
      expect(getEffectiveWorkosClientId()).toBe('client_01KM5S4D10TKG4VJEXSCRVAMG7');
    });
  });

  it('resolveEnvProfile returns the full profile object', () => {
    withTempConfig(() => {
      setPersistedEnv('local');
      expect(resolveEnvProfile()).toEqual(ENV_PROFILES.local);
    });
  });
});
