import { describe, test, expect, vi, afterEach } from 'vitest';
import { outputError, UnexpectedError, ApiError } from '../error.js';

describe('outputError human mode', () => {
  afterEach(() => vi.restoreAllMocks());

  test('When a code exists, then it is appended so screenshots are diagnosable', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    outputError(new UnexpectedError('Something went wrong. Try again later.', 'UNKNOWN_ERROR'), { human: true });
    expect(write).toHaveBeenCalledWith('Error: Something went wrong. Try again later. (UNKNOWN_ERROR)\n');
  });

  test('When the error has no code, then the line is unchanged', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const err = new ApiError('Organization not found.', 404);
    (err as { code?: string }).code = undefined as unknown as string;
    outputError(err, { human: true });
    expect(write).toHaveBeenCalledWith('Error: Organization not found.\n');
  });
});
