import { describe, it, expect } from 'vitest';
import { program } from '../index.js';

describe('platform command groups', () => {
  it('registers whatsapp with alias wa', () => {
    const wa = program.commands.find((c) => c.name() === 'whatsapp');
    expect(wa).toBeDefined();
    expect(wa!.aliases()).toContain('wa');
  });
  it('registers instagram with alias ig', () => {
    const ig = program.commands.find((c) => c.name() === 'instagram');
    expect(ig).toBeDefined();
    expect(ig!.aliases()).toContain('ig');
  });
});
