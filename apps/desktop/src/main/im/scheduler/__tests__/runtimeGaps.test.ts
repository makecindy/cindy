import { describe, expect, it } from 'vitest';

import { RuntimeGapSet } from '../runtimeGaps';

const gap = (identity: string, generation: string, bindingGeneration = 'binding-123456789') => ({
  identity,
  bindingGeneration,
  generation,
  state: 'dirty' as const,
});

describe('bounded runtime gaps', () => {
  it('keeps every unresolved generation for one binding', () => {
    const gaps = new RuntimeGapSet();
    expect(gaps.adopt(gap('12345678901234567', 'f'.repeat(32)))).toBe(true);
    expect(gaps.adopt(gap('12345678901234567', '1'.repeat(32)))).toBe(true);
    expect(gaps.values()).toEqual([
      gap('12345678901234567', '1'.repeat(32)),
      gap('12345678901234567', 'f'.repeat(32)),
    ]);

    const reversed = new RuntimeGapSet();
    reversed.adopt(gap('12345678901234567', '1'.repeat(32)));
    reversed.adopt(gap('12345678901234567', 'f'.repeat(32)));
    expect(reversed.values()).toEqual(gaps.values());
  });

  it('resolves only the exact identity, binding, and runtime generation', () => {
    const gaps = new RuntimeGapSet();
    const first = gap('12345678901234567', '1'.repeat(32));
    const second = gap('12345678901234567', '2'.repeat(32));
    const nextBinding = gap('12345678901234567', '1'.repeat(32), 'binding-987654321');
    gaps.adopt(first);
    gaps.adopt(second);
    gaps.adopt(nextBinding);

    expect(gaps.resolve(first)).toBe(true);
    expect(gaps.resolve(first)).toBe(false);
    expect(gaps.values()).toEqual([second, nextBinding]);
  });

  it('does not resurrect a dirty generation whose clean frame arrived first', () => {
    const gaps = new RuntimeGapSet();
    const resolvedBeforeDirty = gap('12345678901234567', '3'.repeat(32));

    expect(gaps.resolve(resolvedBeforeDirty)).toBe(true);
    expect(gaps.adopt(resolvedBeforeDirty)).toBe(false);
    expect(gaps.values()).toEqual([]);
  });

  it('keeps a full resolved window fail-closed when a new tombstone crosses the trim boundary', () => {
    const gaps = new RuntimeGapSet();
    const resolvedWindow = Array.from({ length: 32 }, (_, index) =>
      gap('12345678901234567', index.toString(16).padStart(32, '0')),
    );
    const newest = gap('12345678901234567', 'f'.repeat(32));

    for (const runtime of resolvedWindow) expect(gaps.resolve(runtime)).toBe(true);
    expect(gaps.resolve(newest)).toBe(true);

    // The overflowing binding is represented by one bounded lifecycle
    // barrier, so neither the newly inserted tombstone nor an older evicted
    // generation can return through a delayed dirty advertisement.
    expect(gaps.adopt(newest)).toBe(false);
    expect(gaps.adopt(resolvedWindow[0])).toBe(false);
    expect(gaps.values()).toEqual([]);

    const laterClean = gap('12345678901234567', 'e'.repeat(32));
    expect(gaps.resolve(laterClean)).toBe(false);
    expect(gaps.adopt(laterClean)).toBe(false);

    // Rebinding clears the fail-closed barrier and allows the new lifecycle to
    // collect legitimate gaps again.
    expect(gaps.clearIdentity('12345678901234567')).toBe(true);
    expect(gaps.adopt(newest)).toBe(true);
  });

  it('retains at most the protocol limit with deterministic tuple ordering', () => {
    const gaps = new RuntimeGapSet();
    for (let index = 0; index < 9; index += 1) {
      gaps.adopt(gap('12345678901234567', index.toString(16).repeat(32)));
    }
    expect(gaps.values()).toHaveLength(8);
    expect(gaps.values().map((runtime) => runtime.generation)).toEqual([
      '0'.repeat(32),
      '1'.repeat(32),
      '2'.repeat(32),
      '3'.repeat(32),
      '4'.repeat(32),
      '5'.repeat(32),
      '6'.repeat(32),
      '7'.repeat(32),
    ]);
  });

  it('can retire one binding without clearing unrelated account gaps', () => {
    const gaps = new RuntimeGapSet();
    gaps.adopt(gap('12345678901234567', '1'.repeat(32)));
    gaps.adopt(gap('12345678901234568', '2'.repeat(32)));
    expect(gaps.clearIdentity('12345678901234567')).toBe(true);
    expect(gaps.values()).toEqual([gap('12345678901234568', '2'.repeat(32))]);
  });
});
