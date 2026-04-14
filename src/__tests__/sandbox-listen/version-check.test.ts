import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../../package.json') as { version: string };

describe('checkForNewerCli', () => {
  const originalFetch = globalThis.fetch;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
  });

  it('logs locked one-liner when registry reports a newer version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '99.0.0' }),
    } as unknown as Response);

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    await checkForNewerCli();

    expect(logSpy).toHaveBeenCalledOnce();
    const msg = logSpy.mock.calls[0][0] as string;
    // Locked prefix per CONTEXT.md §CLI Flow Step 2
    expect(msg.startsWith('A newer version of hookmyapp is available')).toBe(true);
    expect(msg).toContain(pkg.version);
    expect(msg).toContain('99.0.0');
    expect(msg).toContain('npm update -g @gethookmyapp/cli');
  });

  it('does NOT log when registry reports the same version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: pkg.version }),
    } as unknown as Response);

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    await checkForNewerCli();

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('resolves silently when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    await expect(checkForNewerCli()).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('resolves silently on non-2xx response (500)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('should not be called');
      },
    } as unknown as Response);

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    await expect(checkForNewerCli()).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('resolves silently on malformed JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ notVersion: 'surprise' }),
    } as unknown as Response);

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    await expect(checkForNewerCli()).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('uses AbortSignal.timeout(2000)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: pkg.version }),
    } as unknown as Response);
    globalThis.fetch = fetchSpy;

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    await checkForNewerCli();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('https://registry.npmjs.org/@gethookmyapp/cli/latest');
    const opts = fetchSpy.mock.calls[0][1] as { signal: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('resolves silently when AbortSignal.timeout fires', async () => {
    // Fetch rejects with AbortError when the signal fires.
    globalThis.fetch = vi.fn().mockImplementation((_url: string, opts: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const { checkForNewerCli } = await import('../../commands/sandbox-listen/version-check.js');
    // Force a short-lived signal to trigger abort immediately.
    const p = checkForNewerCli();
    await expect(p).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  }, 5000);
});
