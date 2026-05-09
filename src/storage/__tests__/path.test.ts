import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getConfigDir } from '../path.js';

describe('getConfigDir', () => {
  let originalHookmyappDir: string | undefined;
  let originalXdg: string | undefined;

  beforeEach(() => {
    originalHookmyappDir = process.env.HOOKMYAPP_CONFIG_DIR;
    originalXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.HOOKMYAPP_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (originalHookmyappDir !== undefined) process.env.HOOKMYAPP_CONFIG_DIR = originalHookmyappDir;
    if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg;
  });

  it('honors HOOKMYAPP_CONFIG_DIR with the highest priority', () => {
    process.env.HOOKMYAPP_CONFIG_DIR = '/tmp/explicit';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    expect(getConfigDir()).toBe('/tmp/explicit');
  });

  it('falls back to XDG_CONFIG_HOME/hookmyapp when set and HOOKMYAPP_CONFIG_DIR unset', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    expect(getConfigDir()).toBe(join('/tmp/xdg', 'hookmyapp'));
  });

  it('defaults to ~/.config/hookmyapp/ when neither env var set', () => {
    expect(getConfigDir()).toBe(join(homedir(), '.config', 'hookmyapp'));
  });
});
