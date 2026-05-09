import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Each test gets its own isolated config dir via HOOKMYAPP_CONFIG_DIR so
// getConfigDir() (used by getSkillMarkerPath) resolves to our temp dir.
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'hookmyapp-version-headers-test-'));
  process.env.HOOKMYAPP_CONFIG_DIR = configDir;
});

afterEach(() => {
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  delete process.env.HOOKMYAPP_CONFIG_DIR;
});

describe('buildVersionHeaders', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('emits the always-present header set with CLI version', async () => {
    const { buildVersionHeaders } = await import('../version-headers.js');
    const headers = buildVersionHeaders();

    expect(headers['User-Agent']).toMatch(
      /^hookmyapp-cli\/\d+\.\d+\.\d+ \(node\/[^;]+; \w+; \w+\)$/,
    );
    expect(headers['X-HookMyApp-CLI-Version']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(headers['X-HookMyApp-Lang']).toBe('node');
    expect(headers['X-HookMyApp-Runtime-Version']).toBe(process.versions.node);
    expect(headers['X-HookMyApp-Arch']).toBe(process.arch);
    expect(headers['X-HookMyApp-OS']).toBe(process.platform);
  });

  it('omits X-HookMyApp-Skill-Version when marker file is absent', async () => {
    const { buildVersionHeaders } = await import('../version-headers.js');
    expect(buildVersionHeaders()['X-HookMyApp-Skill-Version']).toBeUndefined();
  });

  it('sets X-HookMyApp-Skill-Version to the marker value when valid', async () => {
    writeFileSync(join(configDir, 'skill-version'), '0.6.1\n', 'utf-8');
    vi.resetModules();
    const { buildVersionHeaders } = await import('../version-headers.js');
    expect(buildVersionHeaders()['X-HookMyApp-Skill-Version']).toBe('0.6.1');
  });

  it("sets X-HookMyApp-Skill-Version to 'invalid' when marker is corrupt", async () => {
    writeFileSync(join(configDir, 'skill-version'), 'not-a-semver', 'utf-8');
    vi.resetModules();
    const { buildVersionHeaders } = await import('../version-headers.js');
    expect(buildVersionHeaders()['X-HookMyApp-Skill-Version']).toBe('invalid');
  });
});
