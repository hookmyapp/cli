import { describe, test, expect } from 'vitest';
import { displayEmail } from '../mask.js';

// Lockstep contract: these expectations mirror maskEmail in the hookmyapp
// backend instruction template (AIT-256). If one side changes, both must.
describe('displayEmail', () => {
  test('masks local part after 2 chars and domain to first char + tld', () => {
    expect(displayEmail('info@ordvir.com')).toBe('in***@o***.com');
    expect(displayEmail('edgargov55@gmail.com')).toBe('ed***@g***.com');
  });

  test('never emits the raw address', () => {
    for (const raw of ['info@ordvir.com', 'edgargov55@gmail.com']) {
      expect(displayEmail(raw)).not.toContain(raw);
      expect(displayEmail(raw)).not.toContain(raw.split('@')[0]);
    }
  });

  test('degrades safely on malformed input without leaking it', () => {
    expect(displayEmail('nodomain')).toBe('***');
    expect(displayEmail('@lead.com')).toBe('***');
    expect(displayEmail('a@b')).toBe('a***@b***');
  });
});
