import { describe, expect, it } from 'vitest';

import {
  diffHomeDeviceSyncScope,
  HOME_DEVICE_SYNC_CONCURRENCY,
  HomeDeviceSyncLimiter,
  readHomeSessionList,
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

// PR #10685, unit: production list-read composition must keep old active tasks
// when 200 newer archived tasks fill the all-status ceiling. Existing scope/limiter
// tests never exercised result membership. No network, store or timers are used.
describe('home session list allowance', () => {
  const old = { id: 'old-active', updatedAt: '2026-01-01T00:00:00Z' };
  const history = Array.from({ length: 200 }, (_, i) => ({ id: `archive-${i}`, updatedAt: '2026-11-18T00:00:00Z' }));
  it('retains active tasks when archive history fills the all-status ceiling', async () => {
    const calls: string[] = [];
    const result = await readHomeSessionList('all', async status => {
      calls.push(status);
      return status === 'active' ? [old] : history;
    });
    expect(result).toHaveLength(201);
    expect(result.find(row => row.id === old.id)).toEqual(old);
    expect(result[0].id).toBe('archive-0');
    expect(calls).toEqual(['active', 'archived']);
  });
  it('keeps the later snapshot for an ID that changed status between reads', async () => {
    const newer = { ...old, updatedAt: '2026-11-18T01:00:00Z' };
    expect(await readHomeSessionList('all', async status => status === 'active' ? [old] : [newer])).toEqual([newer]);
  });
  it.each(['active', 'archived'] as const)('keeps the single %s query and its original results', async status => {
    const calls: string[] = [];
    expect(await readHomeSessionList(status, async filter => { calls.push(filter); return [old]; })).toEqual([old]);
    expect(calls).toEqual([status]);
  });
  it('rejects a partial snapshot when the archive read fails', async () => {
    await expect(readHomeSessionList('all', async status => {
      if (status === 'archived') throw new Error('offline');
      return [old];
    })).rejects.toThrow('offline');
  });
});
