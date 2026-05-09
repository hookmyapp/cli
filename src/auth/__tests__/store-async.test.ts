import { describe, it, expect } from 'vitest';
import { saveCredentials, readCredentials, deleteCredentials } from '../store.js';

describe('store (async API)', () => {
  it('saveCredentials returns a Promise', () => {
    const r = saveCredentials({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    expect(r).toBeInstanceOf(Promise);
  });
  it('readCredentials returns a Promise', () => {
    expect(readCredentials()).toBeInstanceOf(Promise);
  });
  it('deleteCredentials returns a Promise', () => {
    expect(deleteCredentials()).toBeInstanceOf(Promise);
  });
});
