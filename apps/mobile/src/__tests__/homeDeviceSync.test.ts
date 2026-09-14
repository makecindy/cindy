import { describe, expect, it } from 'vitest';

import {
  diffHomeDeviceSyncScope,
  HOME_DEVICE_SYNC_CONCURRENCY,
  HomeDeviceSyncLimiter,
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
