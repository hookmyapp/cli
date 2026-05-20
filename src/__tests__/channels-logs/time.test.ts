import { describe, it, expect } from 'vitest';
import { parseTimeArg } from '../../commands/channels-logs/time.js';
import { ValidationError } from '../../output/error.js';

describe('parseTimeArg', () => {
  const now = new Date('2026-05-20T12:00:00.000Z');

  it('resolves a relative hour shorthand against now', () => {
    expect(parseTimeArg('2h', now)).toBe('2026-05-20T10:00:00.000Z');
  });

  it('resolves a relative day shorthand against now', () => {
    expect(parseTimeArg('7d', now)).toBe('2026-05-13T12:00:00.000Z');
  });

  it('resolves relative minute and second shorthands', () => {
    expect(parseTimeArg('30m', now)).toBe('2026-05-20T11:30:00.000Z');
    expect(parseTimeArg('45s', now)).toBe('2026-05-20T11:59:15.000Z');
  });

  it('passes an ISO-8601 timestamp through, normalized to UTC', () => {
    expect(parseTimeArg('2026-05-19T08:30:00Z', now)).toBe(
      '2026-05-19T08:30:00.000Z',
    );
  });

  it('throws ValidationError on an unparseable value', () => {
    expect(() => parseTimeArg('yesterday', now)).toThrow(ValidationError);
  });

  it('throws ValidationError on a zero-unit relative value', () => {
    expect(() => parseTimeArg('2x', now)).toThrow(ValidationError);
  });
});
