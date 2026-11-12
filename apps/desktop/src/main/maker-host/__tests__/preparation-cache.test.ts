import { describe, expect, it, vi } from 'vitest';
import { PreparationCache } from '../preparation-cache.js';

describe('successful preparation cache', () => {
  it('coalesces concurrent calls and expires completed work', async () => {
    let now = 0;
    let release!: (ok: boolean) => void;
    const cache = new PreparationCache(30_000, () => now);
    const prepare = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const a = cache.ensure('owner:1', prepare);
    const b = cache.ensure('owner:1', prepare);
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(1);
    release(true);
    await Promise.all([a, b]);
    await cache.ensure('owner:1', prepare);
    expect(prepare).toHaveBeenCalledTimes(1);
    now = 30_000;
    const c = cache.ensure('owner:1', prepare);
    await Promise.resolve(); release(true); await c;
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures, warnings, or an invalidated owner completion', async () => {
    const cache = new PreparationCache(30_000);
    const prepare = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('failed')).mockResolvedValue(true);
    await cache.ensure('owner:1', prepare);
    await expect(cache.ensure('owner:1', prepare)).rejects.toThrow('failed');
    await cache.ensure('owner:1', prepare);
    await cache.ensure('owner:2', prepare);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('serializes owners without reusing the old owner result', async () => {
    const cache = new PreparationCache(30_000);
    let release!: (ok: boolean) => void;
    const first = cache.ensure('a', () => new Promise((resolve) => { release = resolve; }));
    const other = vi.fn(async () => true);
    const second = cache.ensure('b', other);
    await Promise.resolve();
    expect(other).not.toHaveBeenCalled();
    release(true);
    await Promise.all([first, second]);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('never caches sequential capability checks at TTL zero, even when the clock moves backwards', async () => {
    let now = 100;
    const cache = new PreparationCache(0, () => now);
    const prepare = vi.fn(async () => true);
    await cache.ensure('owner', prepare);
    now = 50;
    await cache.ensure('owner', prepare);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
