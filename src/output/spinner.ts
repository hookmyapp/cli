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
  return ora({ text }).start();
}
