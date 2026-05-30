import { describe, it, expect } from 'vitest';
import { parsePortArg } from '../validate.js';
import { ValidationError } from '../../output/error.js';

describe('parsePortArg', () => {
  it('accepts valid in-range integer ports', () => {
    expect(parsePortArg('3000')).toBe(3000);
    expect(parsePortArg('1')).toBe(1);
    expect(parsePortArg('65535')).toBe(65535);
  });

  it('rejects a partial-numeric value (the old parseInt("3000abc") → 3000 bug)', () => {
    expect(() => parsePortArg('3000abc')).toThrow(ValidationError);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parsePortArg('abc')).toThrow(ValidationError);
  });

  it('rejects out-of-range and fractional values', () => {
    for (const bad of ['0', '65536', '70000', '1.5', '-1']) {
      expect(() => parsePortArg(bad)).toThrow(ValidationError);
    }
  });

  it('names the offending value in the message', () => {
    expect(() => parsePortArg('abc')).toThrow(
      /--port must be an integer between 1 and 65535 \(got "abc"\)/,
    );
  });
});
