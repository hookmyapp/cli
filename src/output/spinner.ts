import ora, { type Ora } from 'ora';

export interface SpinnerHandle {
  stop: () => void;
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
}

// startSpinner returns a real ora spinner when stdout is an interactive TTY
// and the caller is in human mode, or a no-op handle otherwise. This keeps
// --json and CI output clean while still giving humans progress feedback.
export function startSpinner(text: string, json?: boolean): Ora | SpinnerHandle {
  if (json || process.stdout.isTTY !== true) {
    const noop: SpinnerHandle = {
      stop: () => {},
      succeed: () => {},
      fail: () => {},
    };
    return noop;
  }
  // discardStdin:false is REQUIRED: ora's default puts stdin in raw mode while
  // spinning, which consumes the Ctrl+C byte so Node never raises SIGINT and the
  // command becomes un-cancellable. We never prompt while spinning, so leaving
  // stdin untouched is safe and keeps Ctrl+C working.
  return ora({ text, discardStdin: false }).start();
}
