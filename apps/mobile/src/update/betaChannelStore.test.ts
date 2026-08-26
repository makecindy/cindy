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
  enableUncustomizedBetaChannel,
  hydrateBetaChannel,
  isBetaChannel,
  prepareBetaChannelForDevice,
  readBetaChannelState,
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

  it('结构不完整的 metadata fail-safe 为 hold，不允许组织默认开启', async () => {
    storage.set(__testing.metaStorageKey, JSON.stringify({ version: 1 }));

    await expect(hydrateBetaChannel()).resolves.toBe(false);
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: true });
    expect(__testing.hasPersistedMeta()).toBe(false);
    expect(__testing.migrationBlocked()).toBe(true);
    await prepareBetaChannelForDevice({ hadExistingDeviceId: false });
    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
  });

  it('损坏 metadata 存在时不把旧兼容 true 误迁移成用户 override', async () => {
    storage.set(__testing.metaStorageKey, '{broken');
    storage.set(__testing.storageKey, 'true');

    await expect(hydrateBetaChannel()).resolves.toBe(false);
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: true });
    expect(__testing.readState().userOverride).toBeNull();
    expect(__testing.migrationBlocked()).toBe(true);
  });

  it('读取失败时不反写迁移结果，避免抹掉未知的旧用户选择', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(hydrateBetaChannel()).resolves.toBe(false);
    expect(__testing.migrationBlocked()).toBe(true);
    await prepareBetaChannelForDevice({ hadExistingDeviceId: false });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
  });

  it('旧版本 true 迁移为用户 override，后续组织默认不能覆盖', async () => {
    storage.set(__testing.storageKey, 'true');

    await expect(hydrateBetaChannel()).resolves.toBe(true);
    expect(readBetaChannelState()).toEqual({ enableBeta: true, isCustomized: true });
    expect(__testing.readState()).toMatchObject({ userOverride: true });

    await prepareBetaChannelForDevice({ hadExistingDeviceId: true });
    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
    expect(isBetaChannel()).toBe(true);
    expect(__testing.readState()).toMatchObject({ userOverride: true, orgDefaultEnableBeta: false });
  });

  it('新装机解除迁移 hold 后，XD 默认可开启 beta', async () => {
    await hydrateBetaChannel();
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: true });

    await prepareBetaChannelForDevice({ hadExistingDeviceId: false });
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: false });
    await expect(enableUncustomizedBetaChannel()).resolves.toBe(true);
    expect(isBetaChannel()).toBe(true);
    expect(__testing.readState()).toMatchObject({ userOverride: null, orgDefaultEnableBeta: true });
  });

  it('组织默认开启后用户手动关闭，冷启动仍保持关闭', async () => {
    await hydrateBetaChannel();
    await prepareBetaChannelForDevice({ hadExistingDeviceId: false });
    await enableUncustomizedBetaChannel();

    await syncBetaChannel(false);
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: true });
    expect(__testing.readState()).toMatchObject({ userOverride: false, orgDefaultEnableBeta: true });

    await __testing.resetMemory();
    await expect(hydrateBetaChannel()).resolves.toBe(false);
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: true });
    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
  });

  it('自动开启与用户关闭并发时，队列最终保留用户 override', async () => {
    await hydrateBetaChannel();
    await prepareBetaChannelForDevice({ hadExistingDeviceId: false });

    const automatic = enableUncustomizedBetaChannel();
    const optOut = syncBetaChannel(false);
    await Promise.all([automatic, optOut]);

    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: true });
    expect(__testing.readState()).toMatchObject({
      userOverride: false,
      orgDefaultEnableBeta: true,
    });
  });

  it('组织默认落盘前身份失效时不写入', async () => {
    await hydrateBetaChannel();
    await prepareBetaChannelForDevice({ hadExistingDeviceId: false });

    await expect(enableUncustomizedBetaChannel(() => false)).resolves.toBe(false);
    expect(readBetaChannelState()).toEqual({ enableBeta: false, isCustomized: false });
    expect(__testing.readState().orgDefaultEnableBeta).toBe(false);
  });

  it('旧装机无旧 key 保持关闭，组织默认不会覆盖迁移 hold', async () => {
    await hydrateBetaChannel();
    await prepareBetaChannelForDevice({ hadExistingDeviceId: true });

    await expect(enableUncustomizedBetaChannel()).resolves.toBe(false);
    expect(isBetaChannel()).toBe(false);
    expect(readBetaChannelState().isCustomized).toBe(true);
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
    expect(__testing.readState().userOverride).toBe(false);
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

  it('落盘失败时 reject 且不改变内存有效值', async () => {
    await hydrateBetaChannel();
    expect(isBetaChannel()).toBe(false);

    // 模拟 AsyncStorage.setItem 失败
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));

    await expect(syncBetaChannel(true)).rejects.toThrow('disk full');
    // 写入成功前不发布新值，仍保持原来的 stable 状态。
    expect(isBetaChannel()).toBe(false);
  });

  it('连续两次落盘都失败时，仍保持磁盘确认态', async () => {
    await hydrateBetaChannel();
    expect(isBetaChannel()).toBe(false);

    // release → 开 → 关，两次存储操作都失败。
    vi.mocked(AsyncStorage.setItem)
      .mockRejectedValueOnce(new Error('full'))
      .mockRejectedValueOnce(new Error('full'));

    await expect(syncBetaChannel(true)).rejects.toThrow('full');
    await expect(syncBetaChannel(false)).rejects.toThrow('full');
    // 磁盘仍是 release；内存不得漂移到已开。
    expect(isBetaChannel()).toBe(false);
  });

  it('前一次失败、后一次成功时，最终以内存和磁盘的成功值为准', async () => {
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
    // 磁盘已是 beta（第二次成功落盘）；内存也应为 beta。
    expect(isBetaChannel()).toBe(true);
  });
});
