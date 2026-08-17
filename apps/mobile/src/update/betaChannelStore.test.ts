import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  hydrateBetaChannel,
  isBetaChannel,
  subscribeBetaChannel,
  syncBetaChannel,
} from './betaChannelStore';

beforeEach(async () => {
  storage.clear();
  await __testing.resetMemory();
  vi.clearAllMocks();
});

describe('betaChannelStore', () => {
  it('首次安装/坏值默认不启用 beta', async () => {
    expect(isBetaChannel()).toBe(false);
    await expect(hydrateBetaChannel()).resolves.toBe(false);
    expect(isBetaChannel()).toBe(false);

    await __testing.resetMemory();
    storage.set(__testing.storageKey, 'not-true');
    await expect(hydrateBetaChannel()).resolves.toBe(false);
  });

  it('同步 true 跨冷启动恢复;false 删除标记', async () => {
    await syncBetaChannel(true);
    expect(isBetaChannel()).toBe(true);
    expect(storage.get(__testing.storageKey)).toBe('true');

    await __testing.resetMemory();
    await expect(hydrateBetaChannel()).resolves.toBe(true);

    await syncBetaChannel(false);
    expect(isBetaChannel()).toBe(false);
    expect(storage.has(__testing.storageKey)).toBe(false);
  });

  it('切换会通知订阅者，且取消订阅后不再通知', async () => {
    const changes: boolean[] = [];
    const unsubscribe = subscribeBetaChannel(() => changes.push(isBetaChannel()));

    await syncBetaChannel(true);
    await syncBetaChannel(false);
    expect(changes).toEqual([true, false]);

    unsubscribe();
    await syncBetaChannel(true);
    expect(changes).toEqual([true, false]);
  });

  it('落盘失败回滚内存态并 reject，避免「本次按 beta 检查、重启后回 release」漂移', async () => {
    await hydrateBetaChannel();
    expect(isBetaChannel()).toBe(false);

    // 模拟 AsyncStorage.setItem 失败
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));

    await expect(syncBetaChannel(true)).rejects.toThrow('disk full');
    // 回滚到落盘前的旧值(未启用)
    expect(isBetaChannel()).toBe(false);
  });

  it('连续两次落盘都失败时，回滚到磁盘确认态而非上一次的乐观值', async () => {
    await hydrateBetaChannel();
    expect(isBetaChannel()).toBe(false);

    // release → 开 → 关，两次存储操作都失败。
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('full'));
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error('full'));

    await expect(syncBetaChannel(true)).rejects.toThrow('full');
    await expect(syncBetaChannel(false)).rejects.toThrow('full');
    // 磁盘仍是 release；内存不得停留在第一次的乐观值(已开)。
    expect(isBetaChannel()).toBe(false);
  });

  it('前一次失败、后一次成功时，后一次成功不把内存覆盖成磁盘旧值', async () => {
    await hydrateBetaChannel();
    expect(isBetaChannel()).toBe(false);

    // 第一次开：失败；第二次开（同值）：成功。两次并发在同一个 mutation 队列里。
    vi.mocked(AsyncStorage.setItem)
      .mockRejectedValueOnce(new Error('full'))  // 第一次失败
      .mockResolvedValueOnce(undefined);          // 第二次成功

    // 第二次调用（成功）先入队、第一次失败后到 —— 用两个 promise 同时发起。
    const p1 = syncBetaChannel(true);
    const p2 = syncBetaChannel(true);
    await expect(p1).rejects.toThrow('full');
    await expect(p2).resolves.toBeUndefined();
    // 磁盘已是 beta（第二次成功落盘）；内存不得被第一次失败回滚成 release。
    expect(isBetaChannel()).toBe(true);
  });
});
