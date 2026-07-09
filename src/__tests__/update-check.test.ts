import { describe, it, expect } from 'vitest';
import {
  shouldShowUpdateBanner,
  renderUpdateBanner,
  type BannerEnv,
} from '../update-check.js';

const base: BannerEnv = {
  isTTY: true,
  argv: ['node', 'hookmyapp', 'channels', 'list'],
  ci: false,
  currentVersion: '0.12.9',
  update: { current: '0.12.9', latest: '0.12.12' },
};

describe('shouldShowUpdateBanner', () => {
  it('shows when interactive TTY, no --json, update cached', () => {
    expect(shouldShowUpdateBanner(base)).toBe(true);
  });

  it('suppresses when stderr is not a TTY (pipes, agents)', () => {
    expect(shouldShowUpdateBanner({ ...base, isTTY: false })).toBe(false);
  });

  it('suppresses under --json (machine-readable output stays byte-clean)', () => {
    expect(
      shouldShowUpdateBanner({ ...base, argv: [...base.argv, '--json'] }),
    ).toBe(false);
  });

  it('suppresses in CI', () => {
    expect(shouldShowUpdateBanner({ ...base, ci: true })).toBe(false);
  });

  it('suppresses when no update is cached', () => {
    expect(shouldShowUpdateBanner({ ...base, update: undefined })).toBe(false);
  });

  it('suppresses when the cached latest matches the running version (just upgraded)', () => {
    expect(
      shouldShowUpdateBanner({ ...base, currentVersion: '0.12.12' }),
    ).toBe(false);
  });
});

describe('renderUpdateBanner', () => {
  it('renders the Codex-style notice with versions and instructions', () => {
    const banner = renderUpdateBanner({ current: '0.12.9', latest: '0.12.12' });
    expect(banner).toContain('✨ Update available! 0.12.9 -> 0.12.12');
    expect(banner).toContain(
      'Release notes: https://github.com/hookmyapp/cli/releases/latest',
    );
    expect(banner).toContain('npm install -g @gethookmyapp/cli');
  });
});
