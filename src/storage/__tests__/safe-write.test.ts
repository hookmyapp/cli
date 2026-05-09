import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigWriteForbiddenError } from '../errors.js';

const mocks = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: mocks.writeFileSyncMock,
    mkdirSync: mocks.mkdirSyncMock,
  };
});

// Import after vi.mock so the module gets the mocked node:fs
const { safeWriteFileSync } = await import('../path.js');

describe('safeWriteFileSync', () => {
  beforeEach(() => {
    mocks.writeFileSyncMock.mockReset();
    mocks.mkdirSyncMock.mockReset();
  });

  it('throws ConfigWriteForbiddenError on EPERM', () => {
    mocks.writeFileSyncMock.mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(() => safeWriteFileSync('/blocked/path', 'data')).toThrow(ConfigWriteForbiddenError);
  });

  it('throws ConfigWriteForbiddenError on EACCES', () => {
    mocks.writeFileSyncMock.mockImplementation(() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    expect(() => safeWriteFileSync('/blocked/path', 'data')).toThrow(ConfigWriteForbiddenError);
  });

  it('throws ConfigWriteForbiddenError on EROFS (read-only filesystem)', () => {
    mocks.writeFileSyncMock.mockImplementation(() => {
      const err = new Error('EROFS') as NodeJS.ErrnoException;
      err.code = 'EROFS';
      throw err;
    });
    expect(() => safeWriteFileSync('/blocked/path', 'data')).toThrow(ConfigWriteForbiddenError);
  });

  it('throws ConfigWriteForbiddenError when mkdirSync is denied', () => {
    mocks.mkdirSyncMock.mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(() => safeWriteFileSync('/blocked/path', 'data')).toThrow(ConfigWriteForbiddenError);
  });

  it('rethrows other errors as-is', () => {
    mocks.writeFileSyncMock.mockImplementation(() => {
      const err = new Error('ENOSPC') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    });
    expect(() => safeWriteFileSync('/path', 'data')).toThrow(/ENOSPC/);
  });
});
