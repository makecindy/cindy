import { describe, expect, it } from 'vitest';

import {
  diffHomeDeviceSyncScope,
  HOME_DEVICE_SYNC_CONCURRENCY,
  HomeDeviceSyncLimiter,
  HomeSyncRound,
  resolveHomeDeviceSyncIds,
  runHomeDeviceSyncBatch,
} from '@/session/homeDeviceSync';

describe('home device sync scope', () => {
  const devices = [
    { canOpen: true, deviceId: 'dev-a' },
    { canOpen: false, deviceId: 'dev-b' },
    { canOpen: true, deviceId: 'dev-c' },
  ];

  it('syncs every controllable device for all tasks and only the selected device otherwise', () => {
    expect(resolveHomeDeviceSyncIds(devices, null)).toEqual(['dev-a', 'dev-c']);
    expect(resolveHomeDeviceSyncIds(devices, 'dev-c')).toEqual(['dev-c']);
    expect(resolveHomeDeviceSyncIds(devices, 'dev-b')).toEqual([]);
  });

  it('releases hidden owners and acquires only newly visible owners', () => {
    expect(diffHomeDeviceSyncScope(new Set(['dev-a', 'dev-b']), ['dev-b', 'dev-c'])).toEqual({
      acquire: ['dev-c'],
      release: ['dev-a'],
    });
  });

  it('limits startup work to six devices and still completes the queued devices', async () => {
    expect(HOME_DEVICE_SYNC_CONCURRENCY).toBe(6);
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 9 }, (_, index) => index);

    const task = runHomeDeviceSyncBatch(items, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return item * 2;
    });

    await Promise.resolve();
    expect(active).toBe(6);
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }

    await expect(task).resolves.toEqual(items.map((item) => item * 2));
    expect(peak).toBe(6);
  });

  it('falls back to a valid worker count for invalid caller limits', async () => {
    const values = await runHomeDeviceSyncBatch([1, 2], async (item) => item, Number.NaN);
    expect(values).toEqual([1, 2]);
  });

  it('drains devices queued after an unexpected worker rejection', async () => {
    const visited: number[] = [];
    await expect(runHomeDeviceSyncBatch([1, 2, 3, 4], async (item) => {
      visited.push(item);
      if (item === 2) throw new Error('broken peer');
      return item;
    }, 2)).rejects.toThrow('broken peer');
    expect(visited.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('shares six slots across overlapping Home trigger groups and prioritizes visible work', async () => {
    const limiter = new HomeDeviceSyncLimiter();
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const run = (name: string, priority: 'foreground' | 'background') => limiter.run(async () => {
      started.push(name);
      await new Promise<void>((resolve) => releases.push(resolve));
      return name;
    }, priority);

    const initial = Array.from({ length: 7 }, (_, index) => run(`background-${index}`, 'background'));
    const visible = run('visible', 'foreground');
    expect(started).toEqual(Array.from({ length: 6 }, (_, index) => `background-${index}`));

    releases.shift()?.();
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(started.at(-1)).toBe('visible');

    for (let pass = 0; pass < 10; pass += 1) {
      for (const release of releases.splice(0)) release();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
    }
    await Promise.all([...initial, visible]);
  });
});

// Unit regression: overlapping foreground/epoch triggers previously queued complete
// directory rounds. Pending promises expose new-connection progress and stale writes.
it('retires queued same-connection reads and starts a new round before the old read settles', async () => {
  const sync = new HomeSyncRound();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const applied: string[] = [];
  let reads = 0;
  const old = sync.run(async current => {
    reads++;
    await pending;
    if (current()) applied.push('old');
  });
  await Promise.resolve();
  const duplicate = sync.run(async () => { reads++; });
  expect(duplicate).toBe(old);
  await Promise.resolve();
  expect(reads).toBe(1);
  sync.invalidate();
  await sync.run(async current => {
    reads++;
    if (current()) applied.push('new');
  });
  expect(applied).toEqual(['new']);
  release();
  await old;
  expect(reads).toBe(2);
  expect(applied).toEqual(['new']);
  expect(sync.current).toBeNull();
});

it('does not start a retired round or let its completion release the new round', async () => {
  const sync = new HomeSyncRound();
  let obsoleteReads = 0;
  const old = sync.run(async () => { obsoleteReads++; });
  sync.invalidate(); // Background or reconnect before the scheduled read starts.
  let release!: () => void;
  const latest = sync.run(() => new Promise<void>(resolve => { release = resolve; }));
  await old;
  expect(obsoleteReads).toBe(0);
  expect(sync.current).toBe(latest);
  release();
  await latest;
  expect(sync.current).toBeNull();
});

// Review regression: an in-flight filter/manual/budget trigger was silently lost.
// Real round + deferred first read; newest closure must run once before callers settle (unit).
it('runs the latest in-flight trigger once after the current read, including after a failed read', async () => {
  const sync = new HomeSyncRound();
  let release!: () => void;
  const reads: string[] = [];
  const first = sync.run(async () => {
    reads.push('old-filter');
    await new Promise<void>(resolve => { release = resolve; });
    throw new Error('old read failed');
  });
  await Promise.resolve();
  const stale = sync.run(async () => { reads.push('intermediate-filter'); });
  const latest = sync.run(async () => { reads.push('latest-filter'); });
  release();
  await Promise.all([first, stale, latest]);
  expect(reads).toEqual(['old-filter', 'latest-filter']);
  expect(sync.current).toBeNull();
});

it('keeps retired device work inside the same concurrency budget while a new directory round starts', async () => {
  const sync = new HomeSyncRound();
  const limiter = new HomeDeviceSyncLimiter(1);
  let release!: () => void;
  const events: string[] = [];
  const old = sync.run(() => limiter.run(async () => {
    events.push('old-device');
    await new Promise<void>(resolve => { release = resolve; });
  }));
  await Promise.resolve();
  sync.invalidate();
  const latest = sync.run(async () => {
    events.push('new-directory');
    await limiter.run(async () => { events.push('new-device'); });
  });
  await Promise.resolve();
  expect(events).toEqual(['old-device', 'new-directory']);
  release();
  await Promise.all([old, latest]);
  expect(events).toEqual(['old-device', 'new-directory', 'new-device']);
});
