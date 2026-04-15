import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliError, AuthError, NetworkError, ApiError, outputError } from '../output/error.js';

describe('error classes', () => {
  it('CliError stores userMessage, code, and optional statusCode', () => {
    const err = new CliError('Something broke', 'CUSTOM_CODE', 422);
    expect(err.userMessage).toBe('Something broke');
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.statusCode).toBe(422);
    expect(err).toBeInstanceOf(Error);
  });

  it('CliError statusCode is undefined when not provided', () => {
    const err = new CliError('No status', 'NO_STATUS');
    expect(err.statusCode).toBeUndefined();
  });

  it('AuthError sets code to AUTH_REQUIRED and exitCode 4', () => {
    const err = new AuthError('Not logged in');
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.userMessage).toBe('Not logged in');
    expect(err.exitCode).toBe(4);
    expect(err).toBeInstanceOf(CliError);
  });

  it('NetworkError has default message and code NETWORK_ERROR', () => {
    const err = new NetworkError();
    expect(err.userMessage).toBe('Could not connect to HookMyApp API. Check your internet connection or try again later.');
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err).toBeInstanceOf(CliError);
  });

  it('NetworkError accepts custom message', () => {
    const err = new NetworkError('DNS failed');
    expect(err.userMessage).toBe('DNS failed');
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('ApiError with status >= 500 sets code to SERVER_ERROR', () => {
    const err = new ApiError('Internal error', 500);
    expect(err.code).toBe('SERVER_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err).toBeInstanceOf(CliError);
  });

  it('ApiError with status < 500 sets code to API_ERROR', () => {
    const err = new ApiError('Not found', 404);
    expect(err.code).toBe('API_ERROR');
    expect(err.statusCode).toBe(404);
  });
});

describe('outputError', () => {
  // process.stderr.write has overloaded signatures; `ReturnType<typeof vi.spyOn>`
  // collapses to a too-generic shape that fails TS2322. Let TS infer the
  // concrete MockInstance type from the assignment below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockWrite: any;

  beforeEach(() => {
    mockWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    mockWrite.mockRestore();
  });

  it('in human mode writes Error: <message> to stderr', () => {
    const err = new CliError('Bad request', 'API_ERROR');
    outputError(err, { human: true });
    expect(mockWrite).toHaveBeenCalledWith('Error: Bad request\n');
  });

  it('in JSON mode writes JSON with error and code fields to stderr', () => {
    const err = new CliError('Bad request', 'API_ERROR');
    outputError(err, { human: false });
    const written = (mockWrite.mock.calls[0][0] as string);
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ error: 'Bad request', code: 'API_ERROR' });
  });

  it('in JSON mode includes status field when statusCode is present', () => {
    const err = new ApiError('Not found', 404);
    outputError(err, { human: false });
    const written = (mockWrite.mock.calls[0][0] as string);
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ error: 'Not found', code: 'API_ERROR', status: 404 });
  });

  it('in JSON mode omits status field when statusCode is undefined', () => {
    const err = new CliError('Something broke', 'CUSTOM_CODE');
    outputError(err, { human: false });
    const written = (mockWrite.mock.calls[0][0] as string);
    const parsed = JSON.parse(written.trim());
    expect(parsed).not.toHaveProperty('status');
    expect(parsed).toEqual({ error: 'Something broke', code: 'CUSTOM_CODE' });
  });
});
