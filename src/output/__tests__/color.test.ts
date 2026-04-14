import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('color + TTY detect — Wave 0 RED', () => {
  const origTTY = process.stdout.isTTY;
  const origNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = origTTY;
    if (origNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = origNoColor;
    }
    vi.resetModules();
  });

  it('c.success returns bare string when NO_COLOR set', async () => {
    process.env.NO_COLOR = '1';
    const mod = await import('../color.js');
    expect(mod.c.success('ok')).toBe('ok');
  });

  it('c.error returns bare string when !isTTY', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const mod = await import('../color.js');
    // without TTY, color wrapping is stripped
    const out = mod.c.error('x');
    expect(out).toBe('x');
  });

  it('isHuman false when --json (explicit override)', async () => {
    const { isHuman } = await import('../color.js');
    expect(isHuman(true)).toBe(false);
  });

  it('isHuman false when !isTTY', async () => {
    (process.stdout as unknown as { isTTY: boolean }).isTTY = false;
    const { isHuman } = await import('../color.js');
    expect(isHuman(false)).toBe(false);
  });

  it('icon.stripIfJson strips unicode + trailing space in JSON mode', async () => {
    const { icon } = await import('../color.js');
    expect(icon.stripIfJson('✓ done', true)).toBe('done');
    expect(icon.stripIfJson('✓ done', false)).toBe('✓ done');
  });
});
