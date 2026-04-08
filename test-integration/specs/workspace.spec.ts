import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../helpers/runCli.js';
import { seedSession } from '../helpers/seedSession.js';
import { tmpHome } from '../helpers/tmpHome.js';

const RUN_ID = randomUUID().slice(0, 8);
const wsName = (label: string): string => `cli-it-${RUN_ID}-${label}`;

describe('workspace commands', () => {
  describe('happy path (logged in)', () => {
    it('list returns a non-empty JSON array', async () => {
      const session = await seedSession();
      const { exitCode, stdout } = await runCli(['workspace', 'list'], { home: session.home });
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
      // Each row must have an id and name (sanity that it's the workspace shape).
      for (const w of data) {
        expect(typeof w.id).toBe('string');
        expect(typeof w.name).toBe('string');
      }
    });

    it('new <name> creates a workspace and writes it as the active one', async () => {
      const session = await seedSession();
      const name = wsName('new');
      const { exitCode } = await runCli(['workspace', 'new', name], { home: session.home });
      expect(exitCode).toBe(0);
      const cfgPath = path.join(session.home, '.hookmyapp', 'config.json');
      const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'));
      expect(cfg.activeWorkspaceId).toBeTruthy();

      // The workspace should now appear in `workspace list`.
      const { stdout } = await runCli(['workspace', 'list'], { home: session.home });
      const data = JSON.parse(stdout) as Array<{ id: string; name: string }>;
      const found = data.find((w) => w.name === name);
      expect(found, `expected to find workspace "${name}" in list`).toBeTruthy();
      expect(found!.id).toBe(cfg.activeWorkspaceId);
    });

    it('current shows the active workspace details', async () => {
      const session = await seedSession();
      // Establish a known active workspace by creating a new one.
      const name = wsName('current');
      await runCli(['workspace', 'new', name], { home: session.home });
      const { exitCode, stdout } = await runCli(['workspace', 'current'], { home: session.home });
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      // Default (non-human) output is JSON; should contain the new workspace's name.
      expect(stdout).toContain(name);
    });

    it('use <name> switches active workspace by name', async () => {
      const session = await seedSession();
      const name = wsName('use');
      await runCli(['workspace', 'new', name], { home: session.home });
      // Use the existing workspace by name.
      const { exitCode, stdout } = await runCli(['workspace', 'use', name], {
        home: session.home,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Active workspace');
      expect(stdout).toContain(name);
    });
  });

  describe('AUTH error path', () => {
    it('workspace list returns AUTH error when no credentials', async () => {
      const home = await tmpHome();
      const { exitCode, stderr } = await runCli(['workspace', 'list'], { home });
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/AUTH_REQUIRED|Not logged in|hookmyapp login/i);
    });
  });
});
