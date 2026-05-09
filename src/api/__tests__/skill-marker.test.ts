import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Override homedir() so the marker reader looks at a temp directory we control,
// without monkey-patching ~/.config on the dev machine.
const tmpHome = mkdtempSync(join(tmpdir(), 'hookmyapp-skill-marker-test-'));
const markerDir = join(tmpHome, '.config', 'hookmyapp');

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

afterEach(() => {
  // Each test cleans up after itself; this is a defensive sweep.
  try {
    rmSync(markerDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
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
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'skill-version'), '1.4.2\n', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('1.4.2');
  });

  it('semver with prerelease + build → returns full string', async () => {
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, 'skill-version'),
      '1.4.2-rc.1+sha.abc123',
      'utf-8',
    );
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('1.4.2-rc.1+sha.abc123');
  });

  it('empty file → invalid sentinel', async () => {
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'skill-version'), '', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('whitespace-only file → invalid sentinel', async () => {
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'skill-version'), '  \n\t  \n', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('non-semver content → invalid sentinel (closes the bypass)', async () => {
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'skill-version'), 'v1.4.2', 'utf-8');
    const { readSkillVersion } = await import('../skill-marker.js');
    // Strict semver — leading 'v' is not allowed.
    expect(readSkillVersion()).toBe('invalid');
  });

  it('garbage text → invalid sentinel', async () => {
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, 'skill-version'),
      'rm -rf /\n\necho oops',
      'utf-8',
    );
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
  });

  it('permission-denied (chmod 000) → invalid sentinel, no throw', async () => {
    if (process.platform === 'win32') return; // chmod semantics differ
    const { mkdirSync } = await import('fs');
    mkdirSync(markerDir, { recursive: true });
    const path = join(markerDir, 'skill-version');
    writeFileSync(path, '1.0.0', 'utf-8');
    chmodSync(path, 0o000);
    const { readSkillVersion } = await import('../skill-marker.js');
    expect(readSkillVersion()).toBe('invalid');
    // Restore mode so afterEach can rm.
    chmodSync(path, 0o644);
  });
});
