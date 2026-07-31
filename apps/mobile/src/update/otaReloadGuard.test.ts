import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
let failGetItem = false;
let failSetItem = false;
let failRemoveItem = false;

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (failGetItem) throw new Error('storage unavailable');
      return storage.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      if (failSetItem) throw new Error('storage full');
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      if (failRemoveItem) throw new Error('storage unavailable');
      storage.delete(key);
    }),
  },
}));

import {
  MAX_OTA_RELOAD_ATTEMPTS,
  __testing,
  clearOtaReloadGuardIfLaunched,
  readOtaReloadGuard,
  recordOtaReload,
  shouldBlockOtaReload,
} from './otaReloadGuard';

const KEY = __testing.storageKey;

beforeEach(() => {
  storage.clear();
  failGetItem = false;
  failSetItem = false;
  failRemoveItem = false;
  vi.clearAllMocks();
});

describe('readOtaReloadGuard', () => {
  it('首次安装 → 无记录', async () => {
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: null,
      reloadCount: 0,
    });
  });

  it('坏值(非 JSON / 缺 id)一律按无记录,不阻断正常热更', async () => {
    storage.set(KEY, 'not-json');
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: null,
      reloadCount: 0,
    });
    storage.set(KEY, JSON.stringify({ reloadCount: 9 }));
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: null,
      reloadCount: 0,
    });
  });

  it('次数非法 → 按已试 1 次,不误挡', async () => {
    storage.set(KEY, JSON.stringify({ targetUpdateId: 'u1', reloadCount: -3 }));
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: 'u1',
      reloadCount: 1,
    });
  });

  it('读存储抛错必须抛出:吞成无记录会把计数重置、闸门永远合不上', async () => {
    storage.set(KEY, JSON.stringify({ targetUpdateId: 'u1', reloadCount: 2 }));
    failGetItem = true;
    await expect(readOtaReloadGuard()).rejects.toThrow(/storage unavailable/);
  });
});

describe('recordOtaReload', () => {
  it('同一个 update 累加次数', async () => {
    await recordOtaReload('u1');
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: 'u1',
      reloadCount: 1,
    });
    await recordOtaReload('u1');
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: 'u1',
      reloadCount: 2,
    });
  });

  it('换成另一个 update → 从 1 重新计数', async () => {
    await recordOtaReload('u1');
    await recordOtaReload('u1');
    await recordOtaReload('u2');
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: 'u2',
      reloadCount: 1,
    });
  });

  it('写入失败必须抛出(调用方据此放弃本次 reload)', async () => {
    failSetItem = true;
    await expect(recordOtaReload('u1')).rejects.toThrow(/storage full/);
  });
});

describe('shouldBlockOtaReload', () => {
  it('未达上限不挡', () => {
    expect(
      shouldBlockOtaReload(
        { targetUpdateId: 'u1', reloadCount: MAX_OTA_RELOAD_ATTEMPTS - 1 },
        'u1',
      ),
    ).toBe(false);
  });

  it('达到上限则挡', () => {
    expect(
      shouldBlockOtaReload(
        { targetUpdateId: 'u1', reloadCount: MAX_OTA_RELOAD_ATTEMPTS },
        'u1',
      ),
    ).toBe(true);
  });

  it('目标换了就不挡(计数只对同一个 update 有意义)', () => {
    expect(
      shouldBlockOtaReload(
        { targetUpdateId: 'u1', reloadCount: MAX_OTA_RELOAD_ATTEMPTS },
        'u2',
      ),
    ).toBe(false);
  });
});

describe('clearOtaReloadGuardIfLaunched', () => {
  it('目标 update 已成为当前运行版本 → 清记录', async () => {
    await recordOtaReload('u1');
    await clearOtaReloadGuardIfLaunched('u1');
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: null,
      reloadCount: 0,
    });
  });

  it('reload 后仍跑着别的版本 → 保留记录,下次冷启动继续计数', async () => {
    await recordOtaReload('u1');
    await recordOtaReload('u1');
    await clearOtaReloadGuardIfLaunched('embedded-or-old');
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: 'u1',
      reloadCount: 2,
    });
  });

  it('当前没有 updateId(跑包内 bundle)→ 不清', async () => {
    await recordOtaReload('u1');
    await clearOtaReloadGuardIfLaunched(null);
    await expect(readOtaReloadGuard()).resolves.toEqual({
      targetUpdateId: 'u1',
      reloadCount: 1,
    });
  });

  it('清除失败只吞掉,不抛给启动链', async () => {
    await recordOtaReload('u1');
    failRemoveItem = true;
    await expect(clearOtaReloadGuardIfLaunched('u1')).resolves.toBeUndefined();
  });

  it('读取失败也只吞掉(启动链末端没人能处理这个异常)', async () => {
    await recordOtaReload('u1');
    failGetItem = true;
    await expect(clearOtaReloadGuardIfLaunched('u1')).resolves.toBeUndefined();
  });
});
