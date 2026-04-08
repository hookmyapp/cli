import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.spyOn(console, 'log').mockImplementation(() => {});

import { output } from '../output/format.js';

describe('output formatter', () => {
  beforeEach(() => {
    mockLog.mockClear();
  });

  it('prints JSON.stringify with indent 2 by default', () => {
    const data = { id: 1, name: 'test' };
    output(data, {});
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it('with human=true prints tab-separated table for arrays', () => {
    const data = [
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ];
    output(data, { human: true });

    const calls = mockLog.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('id\tname');
    expect(calls[1]).toBe('1\talice');
    expect(calls[2]).toBe('2\tbob');
  });

  it('with human=true prints key: value lines for objects', () => {
    const data = { id: 1, name: 'test' };
    output(data, { human: true });

    const calls = mockLog.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe('id: 1');
    expect(calls[1]).toBe('name: test');
  });
});
