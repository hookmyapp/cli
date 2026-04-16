// Quick task 260415-nym: prove that `hookmyapp sandbox listen` sources the
// tunnel `env` field from resolveEnv() (config precedence: HOOKMYAPP_ENV >
// config.json "env" > DEFAULT_ENV), NOT from a URL-substring heuristic on
// the effective API base URL. The old detectEnv(apiBaseUrl) would return
// 'local' for any localhost URL and 'staging' only when the substring
// "staging" appeared — both of which are wrong when the operator uses a
// surgical HOOKMYAPP_API_URL override against a non-standard host.
//
// This is a focused unit test against resolveEnv(), which is the source of
// truth after the fix. The full sandbox-listen flow (cloudflared spawn,
// proxy bind, heartbeat) stays covered by existing integration work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveEnv } from '../../config/env-profiles.js';

describe('sandbox-listen: tunnel env is sourced from resolveEnv(), not URL sniffing', () => {
  let tmpConfigDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Fresh temp config dir per test so config.json does NOT leak in from
    // the developer's ~/.hookmyapp or from a previous test's writes.
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'hookmyapp-cli-nym-'));
    savedEnv = { ...process.env };
    process.env.HOOKMYAPP_CONFIG_DIR = tmpConfigDir;
    delete process.env.HOOKMYAPP_ENV;
    delete process.env.HOOKMYAPP_API_URL;
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('returns "staging" when HOOKMYAPP_ENV=staging even if API URL does not contain "staging"', () => {
    process.env.HOOKMYAPP_ENV = 'staging';
    // Old bug: detectEnv("https://api.hookmyapp.com") returned 'production'.
    process.env.HOOKMYAPP_API_URL = 'https://api.hookmyapp.com';
    expect(resolveEnv()).toBe('staging');
  });

  it('returns "production" when HOOKMYAPP_ENV is unset even if API URL points at localhost', () => {
    // Old bug: detectEnv("http://localhost:4312") returned 'local', which the
    // backend would then reject (or route to the wrong sandbox ingress).
    process.env.HOOKMYAPP_API_URL = 'http://localhost:4312';
    expect(resolveEnv()).toBe('production');
  });

  it('returns "local" when HOOKMYAPP_ENV=local regardless of API URL', () => {
    process.env.HOOKMYAPP_ENV = 'local';
    process.env.HOOKMYAPP_API_URL = 'https://api.hookmyapp.com';
    expect(resolveEnv()).toBe('local');
  });
});
