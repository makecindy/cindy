import { describe, expect, it } from 'vitest';

import { createPaletteDiscoveryReuse } from '../paletteDiscoveryReuse.js';

describe('palette discovery reuse', () => {
  it('serves a finished listing inside the window and asks again after it', () => {
    let now = 1_000;
    const reuse = createPaletteDiscoveryReuse<string>({ ttlMs: 30_000, now: () => now });
    expect(reuse.read('k')).toBeUndefined();
    reuse.write('k', 'first', reuse.generation());
    now += 29_999;
    expect(reuse.read('k')).toBe('first');
    now += 1;
    expect(reuse.read('k')).toBeUndefined();
  });

  it('keeps separate contexts apart and evicts the least recently used entry', () => {
    const reuse = createPaletteDiscoveryReuse<string>({ ttlMs: 30_000, maxEntries: 2 });
    reuse.write('a', 'A', reuse.generation());
    reuse.write('b', 'B', reuse.generation());
    // Reading `a` makes it the most recent, so `b` is the next eviction.
    expect(reuse.read('a')).toBe('A');
    reuse.write('c', 'C', reuse.generation());
    expect(reuse.read('b')).toBeUndefined();
    expect(reuse.read('a')).toBe('A');
    expect(reuse.read('c')).toBe('C');
  });

  it('never serves one data owner the entry cached for another', () => {
    let owner = 'owner-a';
    const reuse = createPaletteDiscoveryReuse<string>({ ttlMs: 30_000, scope: () => owner });
    reuse.write('k', 'from-a', reuse.generation());
    expect(reuse.read('k')).toBe('from-a');
    owner = 'owner-b';
    expect(reuse.read('k')).toBeUndefined();
    owner = 'owner-a';
    expect(reuse.read('k')).toBe('from-a');
  });

  it('drops the result of a scan that started before the snapshot was cleared', () => {
    const reuse = createPaletteDiscoveryReuse<string>({ ttlMs: 30_000 });
    const beforeClear = reuse.generation();
    reuse.write('k', 'fresh', reuse.generation());
    reuse.clear();
    // The older scan finishes last and must not overwrite what the clear asked for.
    reuse.write('k', 'stale', beforeClear);
    expect(reuse.read('k')).toBeUndefined();
    reuse.write('k', 'fresh-again', reuse.generation());
    expect(reuse.read('k')).toBe('fresh-again');
  });
});
