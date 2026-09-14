import { describe, expect, it } from 'vitest';

import { RemoteHostHydrationQueue } from '../hydration-queue.js';

describe('RemoteHostHydrationQueue', () => {
  it('serializes operations and continues after a rejection', async () => {
    const queue = new RemoteHostHydrationQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.run(async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
      throw new Error('expected');
    });
    const second = queue.run(async () => {
      events.push('second');
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    release();
    await expect(first).rejects.toThrow('expected');
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('keeps a queued reload from hydrating a snapshot taken before remove completes', async () => {
    const queue = new RemoteHostHydrationQueue();
    let diskHosts = ['remove-me'];
    let poolHosts = ['remove-me'];
    let releaseRemove!: () => void;
    const removeWrite = new Promise<void>((resolve) => { releaseRemove = resolve; });

    const remove = queue.run(async () => {
      await removeWrite;
      diskHosts = [];
      poolHosts = [...diskHosts];
    });
    const reload = queue.run(async () => {
      poolHosts = [...diskHosts];
    });

    await Promise.resolve();
    expect(poolHosts).toEqual(['remove-me']);
    releaseRemove();
    await Promise.all([remove, reload]);
    expect(poolHosts).toEqual([]);
  });
});
