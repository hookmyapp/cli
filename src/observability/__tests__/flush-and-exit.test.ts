import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushAndExit } from '../sentry.js';

// AIT-395: `flushAndExit` used to call `process.exit()` outright. On Windows
// that aborts the process while libuv handles are still closing — the
// `src\win\async.c` assertion + exit code 9 a customer hit on EVERY networked
// command, after the command had already printed the right output.
describe('flushAndExit teardown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('sets the exit code instead of killing the process', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await flushAndExit(3);

    expect(process.exitCode).toBe(3);
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves no timer holding the loop open', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const unref = vi.fn();
    const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never);

    await flushAndExit(0);

    // The force-exit fallback must be unref'd: a ref'd timer would itself keep
    // the process alive for the full drain window on every single command.
    expect(timer).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
