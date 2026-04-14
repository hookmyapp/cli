import pc from 'picocolors';

// isHuman returns true only when the caller is interactive AND the user has
// not opted into machine-readable output (--json) or disabled colors globally
// (NO_COLOR, per https://no-color.org). Commands call this once to decide
// whether to render tables, spinners, and hint lines.
export function isHuman(json?: boolean): boolean {
  return !json && process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function wrap(fn: (s: string) => string) {
  return (s: string): string => {
    if (!pc.isColorSupported) return s;
    if (process.env.NO_COLOR) return s;
    if (process.stdout.isTTY !== true) return s;
    return fn(s);
  };
}

export const c = {
  success: wrap(pc.green),
  error: wrap(pc.red),
  warn: wrap(pc.yellow),
  dim: wrap(pc.dim),
};

export const icon = {
  success: '\u2713', // ✓
  error: '\u2717', // ✗
  arrow: '\u2192', // →
  bullet: '\u2022', // •
  stripIfJson: (s: string, json: boolean): string =>
    json ? s.replace(/[\u2713\u2717\u2192\u2022]\s?/g, '') : s,
};
