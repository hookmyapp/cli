import { describe, it, expect } from 'vitest';
import {
  CliError,
  AuthError,
  PermissionError,
  NetworkError,
  ApiError,
  ValidationError,
  ConflictError,
} from '../error.js';

describe('error hierarchy — Wave 0 RED (ValidationError + ConflictError)', () => {
  it('ValidationError exits 2', () => {
    const err = new ValidationError('bad input');
    expect(err.exitCode).toBe(2);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe('ValidationError');
  });

  it('ConflictError exits 6', () => {
    const err = new ConflictError('phone taken');
    expect(err.exitCode).toBe(6);
    expect(err.code).toBe('CONFLICT');
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe('ConflictError');
  });

  it('ConflictError preserves custom code', () => {
    const err = new ConflictError('X', 'PHONE_TAKEN_ANOTHER');
    expect(err.code).toBe('PHONE_TAKEN_ANOTHER');
  });

  it('existing classes unchanged', () => {
    expect(new AuthError().exitCode).toBe(4);
    expect(new PermissionError('ws').exitCode).toBe(3);
    expect(new NetworkError('x').exitCode).toBe(5);
    expect(new ApiError('x', 500).exitCode).toBe(1);
  });
});
