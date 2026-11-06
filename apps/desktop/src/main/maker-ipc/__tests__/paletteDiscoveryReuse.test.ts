import { describe, expect, it } from 'vitest';

import { createPaletteDiscoveryReuse } from '../paletteDiscoveryReuse.js';

describe('palette discovery reuse', () => {
  it('serves a finished listing inside the window and asks again after it', () => {
    let now = 1_000;
    const reuse = createPaletteDiscoveryReuse<string>({ ttlMs: 30_000, now: () => now });
    expect(reuse.read('k')).toBeUndefined();
    reuse.write('k', 'first');
    now += 29_999;
    expect(reuse.read('k')).toBe('first');
    now += 1;
    expect(reuse.read('k')).toBeUndefined();
  });

  it('keeps separate contexts apart and evicts the least recently used entry', () => {
    const reuse = createPaletteDiscoveryReuse<string>({ ttlMs: 30_000, maxEntries: 2 });
    reuse.write('a', 'A');
    reuse.write('b', 'B');
    // Reading `a` makes it the most recent, so `b` is the next eviction.
    expect(reuse.read('a')).toBe('A');
    reuse.write('c', 'C');
    expect(reuse.read('b')).toBeUndefined();
    expect(reuse.read('a')).toBe('A');
    expect(reuse.read('c')).toBe('C');
  });
});
