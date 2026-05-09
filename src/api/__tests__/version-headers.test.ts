import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpHome = mkdtempSync(join(tmpdir(), 'hookmyapp-version-headers-test-'));
const markerDir = join(tmpHome, '.config', 'hookmyapp');

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
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
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'skill-version'), '0.6.1\n', 'utf-8');
    vi.resetModules();
    const { buildVersionHeaders } = await import('../version-headers.js');
    expect(buildVersionHeaders()['X-HookMyApp-Skill-Version']).toBe('0.6.1');
  });

  it("sets X-HookMyApp-Skill-Version to 'invalid' when marker is corrupt", async () => {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'skill-version'), 'not-a-semver', 'utf-8');
    vi.resetModules();
    const { buildVersionHeaders } = await import('../version-headers.js');
    expect(buildVersionHeaders()['X-HookMyApp-Skill-Version']).toBe('invalid');
  });
});
