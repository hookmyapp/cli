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

  it('in JSON mode writes nested envelope with code, message, and status', () => {
    const err = new CliError('Bad request', 'API_ERROR');
    outputError(err, { human: false });
    const written = (mockWrite.mock.calls[0][0] as string);
    const parsed = JSON.parse(written.trim());
    // CliError has no httpStatus and no statusCode → falls back to 500 sentinel per D1.
    expect(parsed).toEqual({ error: { code: 'API_ERROR', message: 'Bad request', status: 500 } });
  });

  it('in JSON mode includes status field resolved from statusCode', () => {
    const err = new ApiError('Not found', 404);
    outputError(err, { human: false });
    const written = (mockWrite.mock.calls[0][0] as string);
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ error: { code: 'API_ERROR', message: 'Not found', status: 404 } });
  });

  it('in JSON mode falls back to 500 sentinel when no status source is available', () => {
    const err = new CliError('Something broke', 'CUSTOM_CODE');
    outputError(err, { human: false });
    const written = (mockWrite.mock.calls[0][0] as string);
    const parsed = JSON.parse(written.trim());
    // D1 requires `status` on every JSON error — the 500 sentinel surfaces when
    // none of statusCode/httpStatus/ERROR_CODE_STATUS resolve a value.
    expect(parsed).toEqual({ error: { code: 'CUSTOM_CODE', message: 'Something broke', status: 500 } });
  });
});
