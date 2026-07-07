import { describe, it, expect } from 'vitest';
import { parseIdentifier } from '../parseIdentifier.js';
import { ValidationError } from '../../output/error.js';

describe('parseIdentifier — shape detection', () => {
  it('phone → { kind: "phone", value: digits-only }', () => {
    expect(parseIdentifier('+972545434384')).toEqual({ kind: 'phone', value: '972545434384' });
    expect(parseIdentifier('+15551234567')).toEqual({ kind: 'phone', value: '15551234567' });
    expect(parseIdentifier('15551234567')).toEqual({ kind: 'phone', value: '15551234567' });
  });

  it('@handle username → { kind: "username", value: handle-without-@ }', () => {
    expect(parseIdentifier('@ordvir')).toEqual({ kind: 'username', value: 'ordvir' });
    expect(parseIdentifier('@hookmyappsandboxstaging')).toEqual({
      kind: 'username',
      value: 'hookmyappsandboxstaging',
    });
  });

  it('ssn_XXXXXXXX → { kind: "sessionId", value: full publicId }', () => {
    expect(parseIdentifier('ssn_hwj1LX3J')).toEqual({ kind: 'sessionId', value: 'ssn_hwj1LX3J' });
  });

  it('ch_XXXXXXXX → { kind: "channelId", value: full publicId }', () => {
    expect(parseIdentifier('ch_POWomFvq')).toEqual({ kind: 'channelId', value: 'ch_POWomFvq' });
  });

  it('bare letters without @ → ValidationError with username suggestion', () => {
    expect(() => parseIdentifier('ordvir')).toThrow(ValidationError);
    expect(() => parseIdentifier('ordvir')).toThrow(/Did you mean @ordvir/);
  });

  it('empty string → ValidationError', () => {
    expect(() => parseIdentifier('')).toThrow(ValidationError);
  });

  it('garbage like "!!!" → ValidationError listing all recognized shapes', () => {
    expect(() => parseIdentifier('!!!')).toThrow(/not a recognized identifier shape/);
  });
});
