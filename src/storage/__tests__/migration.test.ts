import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateConfigDirIfNeeded } from '../path.js';

describe('migrateConfigDirIfNeeded', () => {
  let oldDir: string;
  let newDir: string;
  let warnings: string[];
  let warnSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    oldDir = mkdtempSync(join(tmpdir(), 'mig-old-'));
    newDir = mkdtempSync(join(tmpdir(), 'mig-new-'));
    rmSync(newDir, { recursive: true, force: true });
    warnings = [];
    warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      warnings.push(String(msg));
      return true;
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(oldDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it('moves config.json from old to new when only old exists', () => {
    writeFileSync(join(oldDir, 'config.json'), '{"x":1}');
    migrateConfigDirIfNeeded(oldDir, newDir);
    expect(existsSync(join(oldDir, 'config.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(newDir, 'config.json'), 'utf-8'))).toEqual({ x: 1 });
  });

  it('no-ops when only new exists', () => {
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'config.json'), '{"y":2}');
    migrateConfigDirIfNeeded(oldDir, newDir);
    expect(JSON.parse(readFileSync(join(newDir, 'config.json'), 'utf-8'))).toEqual({ y: 2 });
  });

  it('no-ops when neither exists', () => {
    expect(() => migrateConfigDirIfNeeded(oldDir, newDir)).not.toThrow();
    expect(existsSync(newDir)).toBe(false);
  });

  it('prefers new and warns when both exist', () => {
    writeFileSync(join(oldDir, 'config.json'), '{"x":1}');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'config.json'), '{"y":2}');
    migrateConfigDirIfNeeded(oldDir, newDir);
    expect(JSON.parse(readFileSync(join(newDir, 'config.json'), 'utf-8'))).toEqual({ y: 2 });
    expect(existsSync(join(oldDir, 'config.json'))).toBe(true);
    expect(warnings.some((w) => w.includes('both') || w.includes('manual'))).toBe(true);
  });
});
