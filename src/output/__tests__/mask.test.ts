import { describe, test, expect } from 'vitest';
import { displayEmail } from '../mask.js';

// Lockstep contract: these expectations mirror maskEmail in the hookmyapp
// backend instruction template (AIT-256). If one side changes, both must.
// The [xxxx] tag is the first 4 hex chars of sha256(trimmed lowercased email).
describe('displayEmail', () => {
  test('masks local part after 2 chars, domain to first char + tld, and appends the discriminator', () => {
    expect(displayEmail('info@ordvir.com')).toBe('in***@o***.com [115c]');
    expect(displayEmail('edgargov55@gmail.com')).toBe('ed***@g***.com [a52e]');
  });

  test('never emits the raw address', () => {
    for (const raw of ['info@ordvir.com', 'edgargov55@gmail.com']) {
      expect(displayEmail(raw)).not.toContain(raw);
      expect(displayEmail(raw)).not.toContain(raw.split('@')[0]);
    }
  });

  test('colliding masked prefixes stay distinguishable via the discriminator', () => {
    expect(displayEmail('info@ordvir.com')).not.toBe(displayEmail('invoice@other.com'));
  });

  test('degrades safely on malformed input without leaking it', () => {
    expect(displayEmail('nodomain')).toMatch(/^\*\*\* \[[0-9a-f]{4}\]$/);
    expect(displayEmail('@lead.com')).toMatch(/^\*\*\* \[[0-9a-f]{4}\]$/);
    expect(displayEmail('a@b')).toMatch(/^a\*\*\*@b\*\*\* \[[0-9a-f]{4}\]$/);
  });
});
