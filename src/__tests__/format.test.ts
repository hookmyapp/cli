import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { output } from '../output/format.js';

// NOTE: The canonical output() contract moved to src/output/__tests__/format.test.ts
// as of phase 108-04. Those tests exercise the new { json, nudge, kind } shape
// against cli-table3 rendering. The cases below cover the back-compat `human`
// flag that existing callers (workspace.ts, billing.ts) still pass.
describe('output formatter back-compat', () => {
  beforeEach(() => {
    mockLog.mockClear();
  });

  it('human=false forces JSON output', () => {
    const data = { id: 1, name: 'test' };
    output(data, { human: false });
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it('json=true forces JSON output even without human flag', () => {
    const data = { id: 1, name: 'test' };
    output(data, { json: true });
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it('human=true prints key: value lines for flat objects', () => {
    const data = { id: 1, name: 'test' };
    output(data, { human: true });

    const calls = mockLog.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('id: 1');
    expect(calls[1]).toBe('name: test');
  });
});
