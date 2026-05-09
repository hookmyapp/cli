import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Each test gets its own isolated config dir via HOOKMYAPP_CONFIG_DIR so
// getConfigDir() (used by getSkillMarkerPath) resolves to our temp dir.
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'hookmyapp-skill-marker-test-'));
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

describe('readSkillVersion — 3-state contract', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('absent file → undefined (header omitted)', async () => {
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBeUndefined();
  });

  it('parseable semver → returns the value', async () => {
    writeFileSync(join(configDir, 'skill-version'), '1.4.2\n', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('1.4.2');
  });

  it('semver with prerelease + build → returns full string', async () => {
    writeFileSync(
      join(configDir, 'skill-version'),
      '1.4.2-rc.1+sha.abc123',
      'utf-8',
    );
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('1.4.2-rc.1+sha.abc123');
  });

  it('empty file → invalid sentinel', async () => {
    writeFileSync(join(configDir, 'skill-version'), '', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('whitespace-only file → invalid sentinel', async () => {
    writeFileSync(join(configDir, 'skill-version'), '  \n\t  \n', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('non-semver content → invalid sentinel (closes the bypass)', async () => {
    writeFileSync(join(configDir, 'skill-version'), 'v1.4.2', 'utf-8');
    // Strict semver — leading 'v' is not allowed.
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('garbage text → invalid sentinel', async () => {
    writeFileSync(
      join(configDir, 'skill-version'),
      'rm -rf /\n\necho oops',
      'utf-8',
    );
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('permission-denied (chmod 000) → invalid sentinel, no throw', async () => {
    if (process.platform === 'win32') return; // chmod semantics differ
    const path = join(configDir, 'skill-version');
    writeFileSync(path, '1.0.0', 'utf-8');
    chmodSync(path, 0o000);
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
    // Restore mode so afterEach can rm.
    chmodSync(path, 0o644);
  });
});
