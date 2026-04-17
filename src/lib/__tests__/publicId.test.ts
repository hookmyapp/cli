import { describe, it, expect } from 'vitest';
import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_PREFIXES,
  isValidPublicId,
} from '../publicId.js';

describe('publicId local-fallback helpers', () => {
  it('alphabet is the 62-char Stripe-style alphanumeric alphabet (verbatim copy from @hookmyapp/shared)', () => {
    expect(PUBLIC_ID_ALPHABET).toBe(
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    );
    expect(PUBLIC_ID_ALPHABET).toHaveLength(62);
  });

  it('PUBLIC_ID_LENGTH is 8 (matches @hookmyapp/shared)', () => {
    expect(PUBLIC_ID_LENGTH).toBe(8);
  });

  it('PUBLIC_ID_PREFIXES locks the 6 product prefixes', () => {
    expect(PUBLIC_ID_PREFIXES).toEqual(['ws', 'ch', 'usr', 'inv', 'ssn', 'mem']);
  });

  describe('isValidPublicId — positive cases', () => {
    const cases: Array<[string, 'ws' | 'ch' | 'usr' | 'inv' | 'ssn' | 'mem']> = [
      ['ws_A4zq8d2T', 'ws'],
      ['ch_abcdEFGH', 'ch'],
      ['usr_00000000', 'usr'],
      ['inv_zzzzzzzz', 'inv'],
      ['ssn_Aa1Bb2Cc', 'ssn'],
      ['mem_9876abcd', 'mem'],
    ];
    for (const [value, prefix] of cases) {
      it(`accepts ${value} under prefix ${prefix}`, () => {
        expect(isValidPublicId(value, prefix)).toBe(true);
      });
    }
  });

  describe('isValidPublicId — negative cases (every rejection path)', () => {
    it('rejects a raw UUID v4', () => {
      expect(isValidPublicId('11111111-2222-4333-8444-555555555555', 'ws')).toBe(false);
    });
    it('rejects the wrong prefix (ch under ws)', () => {
      expect(isValidPublicId('ch_abcdefgh', 'ws')).toBe(false);
    });
    it('rejects too-short body (7 chars)', () => {
      expect(isValidPublicId('ws_abcdefg', 'ws')).toBe(false);
    });
    it('rejects too-long body (9 chars)', () => {
      expect(isValidPublicId('ws_abcdefghi', 'ws')).toBe(false);
    });
    it('rejects a dash in the body', () => {
      expect(isValidPublicId('ws_abcd-fgh', 'ws')).toBe(false);
    });
    it('rejects an underscore in the body', () => {
      expect(isValidPublicId('ws_abcd_fgh', 'ws')).toBe(false);
    });
    it('rejects a missing prefix', () => {
      expect(isValidPublicId('abcdEFGH', 'ws')).toBe(false);
    });
    it('rejects missing separator', () => {
      expect(isValidPublicId('wsabcdEFGH', 'ws')).toBe(false);
    });
    it('rejects undefined', () => {
      expect(isValidPublicId(undefined, 'ws')).toBe(false);
    });
    it('rejects null', () => {
      expect(isValidPublicId(null, 'ws')).toBe(false);
    });
    it('rejects a number', () => {
      expect(isValidPublicId(12345678, 'ws')).toBe(false);
    });
    it('rejects an empty string', () => {
      expect(isValidPublicId('', 'ws')).toBe(false);
    });
  });
});
