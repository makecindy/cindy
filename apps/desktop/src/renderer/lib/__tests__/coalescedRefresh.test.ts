import { describe, expect, it, vi } from 'vitest';
import { createCoalescedRefresh } from '../coalescedRefresh';

describe('coalesced refresh', () => {
  it('combines same-turn notifications before starting a read', async () => {
    const schedule = createCoalescedRefresh<number>();
    const read = vi.fn(async () => 1);
    await Promise.all(Array.from({ length: 20 }, () => schedule(read)));
    expect(read).toHaveBeenCalledOnce();
  });

  it('runs the latest invalidation after failure without retrying a failed read', async () => {
    const schedule = createCoalescedRefresh<number>();
    let reject!: (error: Error) => void;
    const failing = vi.fn(
      () =>
        new Promise<number>((_, r) => {
          reject = r;
        }),
    );
    const first = schedule(failing);
    await Promise.resolve();
    const skipped = vi.fn(async () => 2);
    const intermediate = schedule(skipped);
    const latest = schedule(async () => 3);
    reject(new Error('failed'));
    expect(await Promise.all([first, intermediate, latest])).toEqual([3, 3, 3]);
    expect(skipped).not.toHaveBeenCalled();
    expect(failing).toHaveBeenCalledOnce();
    await expect(
      schedule(async () => {
        throw new Error('final failure');
      }),
    ).rejects.toThrow('final failure');
    await expect(schedule(async () => 4)).resolves.toBe(4);
  });
});
