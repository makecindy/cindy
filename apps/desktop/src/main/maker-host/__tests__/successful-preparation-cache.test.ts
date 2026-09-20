import { describe, expect, it, vi } from 'vitest';

import { SuccessfulPreparationCache } from '../successful-preparation-cache.js';

describe('SuccessfulPreparationCache', () => {
  it('coalesces concurrent work and reuses a successful completion', async () => {
    let release!: (cacheable: boolean) => void;
    const prepare = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new SuccessfulPreparationCache(300_000, () => 1_000);

    const first = cache.ensure('owner-a', prepare);
    const second = cache.ensure('owner-a', prepare);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));

    release(true);
    await Promise.all([first, second]);
    await cache.ensure('owner-a', prepare);

    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('retries unsuccessful and rejected preparations', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce(true);
    const cache = new SuccessfulPreparationCache(300_000, () => 1_000);

    await cache.ensure('owner-a', prepare);
    await expect(cache.ensure('owner-a', prepare)).rejects.toThrow('scan failed');
    await cache.ensure('owner-a', prepare);
    await cache.ensure('owner-a', prepare);

    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('does not cache a completion invalidated at an async owner boundary', async () => {
    let ownerGeneration = 1;
    const prepare = vi.fn(async () => {
      const startedFor = ownerGeneration;
      await Promise.resolve();
      return startedFor === ownerGeneration;
    });
    const cache = new SuccessfulPreparationCache(300_000, () => 1_000);

    await cache.ensure('owner-a:1', async () => {
      const pending = prepare();
      ownerGeneration = 2;
      return pending;
    });
    await cache.ensure('owner-a:1', prepare);

    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('expires successful completions', async () => {
    let now = 1_000;
    const prepare = vi.fn(async () => true);
    const cache = new SuccessfulPreparationCache(300_000, () => now);

    await cache.ensure('owner-a', prepare);
    now += 299_999;
    await cache.ensure('owner-a', prepare);
    now += 1;
    await cache.ensure('owner-a', prepare);

    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('uses a zero TTL only for concurrent coalescing', async () => {
    const prepare = vi.fn(async () => true);
    const cache = new SuccessfulPreparationCache(0, () => 1_000);

    await cache.ensure('owner-a', prepare);
    await cache.ensure('owner-a', prepare);

    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('waits for an old owner before preparing the current owner', async () => {
    let releaseOwnerA!: (cacheable: boolean) => void;
    const ownerAPrepare = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          releaseOwnerA = resolve;
        }),
    );
    const ownerBPrepare = vi.fn(async () => true);
    const cache = new SuccessfulPreparationCache(300_000, () => 1_000);

    const ownerA = cache.ensure('owner-a', ownerAPrepare);
    const ownerB = cache.ensure('owner-b', ownerBPrepare);
    await vi.waitFor(() => expect(ownerAPrepare).toHaveBeenCalledTimes(1));
    expect(ownerBPrepare).not.toHaveBeenCalled();

    releaseOwnerA(true);
    await Promise.all([ownerA, ownerB]);

    expect(ownerBPrepare).toHaveBeenCalledTimes(1);
  });
});
