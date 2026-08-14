import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAndExit } from '../sentry.js';

// AIT-395: `flushAndExit` used to call `process.exit()` outright. On Windows
// that aborts the process while libuv handles are still closing — the
// `src\win\async.c` assertion + exit code 9 a customer hit on EVERY networked
// command, after the command had already printed the right output.
describe('flushAndExit teardown', () => {
  // Fake timers so the unref'd watchdog that flushAndExit schedules cannot
  // outlive the test, fire against the by-then-restored real process.exit,
  // and take the vitest worker down with it.
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
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

    // EVERY timer this path schedules must be unref'd — the force-exit
    // watchdog and the agent-close race alike. A single ref'd timer would keep
    // the process alive for its full window on every command.
    expect(timer.mock.calls.length).toBeGreaterThan(0);
    expect(unref).toHaveBeenCalledTimes(timer.mock.calls.length);
    expect(exit).not.toHaveBeenCalled();
  });
});
