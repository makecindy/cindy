import { describe, expect, it } from 'vitest';

import { RuntimeGapSet } from '../runtimeGaps';

const gap = (identity: string, generation: string) => ({
  identity,
  generation,
  state: 'dirty' as const,
});

describe('bounded runtime gaps', () => {
  it('keeps the deterministic lexical winner for one identity', () => {
    const gaps = new RuntimeGapSet();
    expect(gaps.adopt(gap('12345678901234567', 'f'.repeat(32)))).toBe(true);
    expect(gaps.adopt(gap('12345678901234567', '1'.repeat(32)))).toBe(true);
    expect(gaps.values()).toEqual([gap('12345678901234567', '1'.repeat(32))]);
  });

  it('retains at most the protocol limit and resolves by generation', () => {
    const gaps = new RuntimeGapSet();
    for (let index = 0; index < 9; index += 1) {
      gaps.adopt(gap(String(index), `${String(index + 1)}`.repeat(32)));
    }
    expect(gaps.values()).toHaveLength(8);
    expect(gaps.resolve('1'.repeat(32))).toBe(true);
    expect(gaps.resolve('1'.repeat(32))).toBe(false);
  });
});
