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

describe('facebook command group', () => {
  const fb = program.commands.find((c) => c.name() === 'facebook');
  it('registers facebook with alias fb', () => {
    expect(fb).toBeDefined();
    expect(fb!.aliases()).toContain('fb');
  });
  it('mounts every documented subcommand', () => {
    const names = fb!.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['comments', 'delete-post', 'insights', 'messages', 'posts', 'profile', 'publish', 'threads']);
    const comments = fb!.commands.find((c) => c.name() === 'comments')!;
    expect(comments.commands.map((c) => c.name()).sort()).toEqual(['delete', 'hide', 'list', 'private-reply', 'reply', 'unhide']);
    const messages = fb!.commands.find((c) => c.name() === 'messages')!;
    expect(messages.commands.map((c) => c.name()).sort()).toEqual(['read', 'send']);
  });
});
