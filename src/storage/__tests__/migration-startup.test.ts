import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateConfigDirIfNeeded } from '../path.js';

describe('migration runs end-to-end with realistic legacy config', () => {
  let oldDir: string;
  let newDir: string;

  beforeEach(() => {
    oldDir = mkdtempSync(join(tmpdir(), 'startup-old-'));
    newDir = mkdtempSync(join(tmpdir(), 'startup-new-'));
    rmSync(newDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it('preserves all four slices (workspace/env/telemetry/posthog) through the rename', () => {
    const realistic = {
      activeWorkspaceId: 'ws_abcd1234',
      activeWorkspaceSlug: 'acme',
      env: 'staging',
      telemetry: 'on',
      posthogDistinctId: 'cli-uuid-xyz',
    };
    writeFileSync(join(oldDir, 'config.json'), JSON.stringify(realistic));
    migrateConfigDirIfNeeded(oldDir, newDir);
    const after = JSON.parse(readFileSync(join(newDir, 'config.json'), 'utf-8'));
    expect(after).toEqual(realistic);
  });
});
