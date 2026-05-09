import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateConfigDirIfNeeded } from '../path.js';
import { migrateLegacyCredentials, readSecrets, __resetForTests } from '../secrets.js';

describe('upgrade from CLI 0.10.x to 0.11.0', () => {
  let legacy: string;
  let newDir: string;

  beforeEach(() => {
    legacy = mkdtempSync(join(tmpdir(), 'upgrade-legacy-'));
    newDir = mkdtempSync(join(tmpdir(), 'upgrade-new-'));
    rmSync(newDir, { recursive: true, force: true });
    process.env.HOOKMYAPP_CONFIG_DIR = newDir;
    process.env.HOOKMYAPP_DISABLE_KEYCHAIN = '1';
    __resetForTests();
  });

  afterEach(() => {
    rmSync(legacy, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it('migrates a realistic 0.10.x install: config + creds end up at the new location', async () => {
    writeFileSync(
      join(legacy, 'config.json'),
      JSON.stringify({
        activeWorkspaceId: 'ws_abc12345',
        activeWorkspaceSlug: 'acme',
        env: 'production',
        telemetry: 'on',
      }),
    );
    writeFileSync(
      join(legacy, 'credentials.json'),
      JSON.stringify({ accessToken: 'jwt.access', refreshToken: 'jwt.refresh', expiresAt: 1740000000000 }),
    );

    migrateConfigDirIfNeeded(legacy, newDir);
    await migrateLegacyCredentials(legacy);

    expect(existsSync(join(newDir, 'config.json'))).toBe(true);
    expect(await readSecrets()).toEqual({
      accessToken: 'jwt.access',
      refreshToken: 'jwt.refresh',
      expiresAt: 1740000000000,
    });
    expect(existsSync(join(legacy, 'config.json'))).toBe(false);
    expect(existsSync(join(legacy, 'credentials.json'))).toBe(false);
  });
});
