import { describe, it, expect, vi, afterEach } from 'vitest';
import { output } from '../format.js';

// Wave 0 RED: asserts the NEW cli-table3 + kind-aware output() signature.
// Currently output() has signature ({ human?: boolean }) — these tests
// exercise the future ({ json?: boolean, nudge?, kind? }) shape and WILL fail
// because either:
//   (a) cli-table3 is not yet rendered for arrays in human mode, OR
//   (b) opts.json / opts.nudge / opts.kind are not yet recognized.

describe('output() formatting — Wave 0 RED (cli-table3 + nudge + kind)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders cli-table3 for array of flat objects in human mode', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (output as any)(
      [
        { id: 'a', name: 'one' },
        { id: 'b', name: 'two' },
      ],
      { json: false },
    );
    const out =
      logSpy.mock.calls.flat().join('\n') +
      '\n' +
      writeSpy.mock.calls.flat().join('\n');
    // cli-table3 default borders include at least one of these box chars.
    expect(out).toMatch(/[│┬─┌└]/);
  });

  it('emits raw JSON under --json (no table chars)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (output as any)([{ id: 'a' }], { json: true });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toMatch(/[│┬─┌└]/);
    expect(JSON.parse(out)).toEqual([{ id: 'a' }]);
  });

  it('reads suppress nudge (kind: read → no arrow, no nudge text)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (output as any)(
      { id: 'a' },
      { json: false, nudge: 'Run something', kind: 'read' },
    );
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).not.toContain('Run something');
    expect(out).not.toContain('→');
  });

  it('mutations emit nudge prefixed with →', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (output as any)(
      { id: 'a' },
      {
        json: false,
        nudge: 'Next: hookmyapp sandbox listen',
        kind: 'mutation',
      },
    );
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('→');
    expect(out).toContain('hookmyapp sandbox listen');
  });
});
