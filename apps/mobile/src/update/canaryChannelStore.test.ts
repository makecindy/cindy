import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { storage.delete(key); }),
  },
}));

import {
  __testing,
  clearCanaryChannel,
  hydrateCanaryChannel,
  isCanaryChannel,
  subscribeCanaryChannel,
  syncCanaryChannel,
  updateChannelRequestHeaders,
} from './canaryChannelStore';

beforeEach(async () => {
  storage.clear();
  await __testing.resetMemory();
  vi.clearAllMocks();
});

describe('canaryChannelStore', () => {
  it('首次安装/坏值默认 stable', async () => {
    expect(isCanaryChannel()).toBe(false);
    await expect(hydrateCanaryChannel()).resolves.toBe(false);
    expect(isCanaryChannel()).toBe(false);

    await __testing.resetMemory();
    storage.set(__testing.storageKey, 'not-true');
    await expect(hydrateCanaryChannel()).resolves.toBe(false);
  });

  it('同步 true 跨冷启动恢复；false/clear 删除标记', async () => {
    await syncCanaryChannel(true);
    expect(isCanaryChannel()).toBe(true);
    expect(storage.get(__testing.storageKey)).toBe('true');

    await __testing.resetMemory();
    await expect(hydrateCanaryChannel()).resolves.toBe(true);

    await syncCanaryChannel(false);
    expect(isCanaryChannel()).toBe(false);
    expect(storage.has(__testing.storageKey)).toBe(false);

    await syncCanaryChannel(true);
    await clearCanaryChannel();
    expect(isCanaryChannel()).toBe(false);
    expect(storage.has(__testing.storageKey)).toBe(false);
  });

  it('按发布通道决定 header:release 无 header,canary/beta 携带对应值', () => {
    expect(updateChannelRequestHeaders('release')).toEqual({});
    expect(updateChannelRequestHeaders('canary')).toEqual({ 'x-cindy-update-channel': 'canary' });
    expect(updateChannelRequestHeaders('beta')).toEqual({ 'x-cindy-update-channel': 'beta' });
  });

  it('登录/登出切换会通知订阅者，且取消订阅后不再通知', async () => {
    const changes: boolean[] = [];
    const unsubscribe = subscribeCanaryChannel(() => changes.push(isCanaryChannel()));

    await syncCanaryChannel(true);
    await clearCanaryChannel();
    expect(changes).toEqual([true, false]);

    unsubscribe();
    await syncCanaryChannel(true);
    expect(changes).toEqual([true, false]);
  });
});
