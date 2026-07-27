import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「跳过登录」标记落盘的行为级测试(2026-07-27 P1 回归)。
 *
 * 重点是**写入顺序**:标记有三条并发写入方(点跳过 / 拿到真实身份清标记 / 登出),
 * native storage mutation 异步完成,先发出的 `setItem` 可能比后发出的 `removeItem`
 * 更晚 settle。没有串行队列时,内存已是账号态而盘上留下 `"1"`,凭证失效后的下一次
 * 冷启动会错误直入无账号主界面。这里用 deferred promise 人为制造乱序 settle,
 * 断言最终盘上态 == 最后一次调用(= 内存态)。
 */
const asyncStore = vi.hoisted(() => new Map<string, string>());
const getItem = vi.hoisted(() =>
  vi.fn(async (key: string) => asyncStore.get(key) ?? null),
);
const setItem = vi.hoisted(() =>
  vi.fn(async (key: string, value: string) => {
    asyncStore.set(key, value);
  }),
);
const removeItem = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    asyncStore.delete(key);
  }),
);

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem, setItem, removeItem },
}));

import { persistLocalMode, readLocalMode } from '@/auth/localModeStore';

/** 与 localModeStore 的键名口径一致(键名契约另有源码断言锁在 loginSkipLocalMode)。 */
const KEY = 'cindy.mobile.auth.localMode';

/** 让已排队的写有机会跑到 native 调用(宏任务一拍,足够刷完微任务链)。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  // 上一条 case 的队列可能仍未 settle:先等干净再清状态,避免跨 case 串写。
  await flush();
  asyncStore.clear();
  getItem.mockReset();
  setItem.mockReset();
  removeItem.mockReset();
  getItem.mockImplementation(async (key: string) => asyncStore.get(key) ?? null);
  setItem.mockImplementation(async (key: string, value: string) => {
    asyncStore.set(key, value);
  });
  removeItem.mockImplementation(async (key: string) => {
    asyncStore.delete(key);
  });
});

describe('persistLocalMode(写入串行 + best-effort)', () => {
  it('置位写 "1",清除删键', async () => {
    await persistLocalMode(true);
    expect(asyncStore.get(KEY)).toBe('1');
    await persistLocalMode(false);
    expect(asyncStore.has(KEY)).toBe(false);
  });

  it('乱序回归:set(true) 迟到 settle 也不会盖掉后发出的 remove(false)', async () => {
    let releaseSet: () => void = () => undefined;
    const setSettled = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    setItem.mockImplementationOnce(async (key: string, value: string) => {
      await setSettled; // 模拟 native setItem 久久不返回
      asyncStore.set(key, value);
    });

    const skipped = persistLocalMode(true); // ① 用户点「跳过登录」
    const signedIn = persistLocalMode(false); // ② 紧接着登录成功 → 清标记

    await flush();
    // 串行保证:② 在 ① settle 前甚至还没发到 native(否则 remove 可能先落盘)
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(removeItem).not.toHaveBeenCalled();

    releaseSet();
    await Promise.all([skipped, signedIn]);

    // 最终盘上态 == 最后一次调用(账号态),不残留 "1"
    expect(asyncStore.has(KEY)).toBe(false);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(removeItem).toHaveBeenCalledTimes(1);
    await expect(readLocalMode()).resolves.toBe(false);
  });

  it('乱序回归(反向):remove 迟到 settle 也不会盖掉后发出的 set(true)', async () => {
    let releaseRemove: () => void = () => undefined;
    const removeSettled = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    removeItem.mockImplementationOnce(async (key: string) => {
      await removeSettled;
      asyncStore.delete(key);
    });

    const cleared = persistLocalMode(false); // ① 登出清标记
    const skipped = persistLocalMode(true); // ② 用户随后点「跳过登录」

    await flush();
    expect(setItem).not.toHaveBeenCalled();

    releaseRemove();
    await Promise.all([cleared, skipped]);

    expect(asyncStore.get(KEY)).toBe('1');
    await expect(readLocalMode()).resolves.toBe(true);
  });

  it('写失败静默且不卡死队列:后续写照常落盘', async () => {
    setItem.mockImplementationOnce(async () => {
      throw new Error('native storage full');
    });

    await expect(persistLocalMode(true)).resolves.toBeUndefined();
    expect(asyncStore.has(KEY)).toBe(false); // 本次没写进去,但不外抛

    await persistLocalMode(true);
    expect(asyncStore.get(KEY)).toBe('1');
  });
});

describe('readLocalMode(读归一)', () => {
  it('只有 "1" 算已跳过;缺失 / 脏值 / 读异常都归一 false', async () => {
    await expect(readLocalMode()).resolves.toBe(false);

    asyncStore.set(KEY, '1');
    await expect(readLocalMode()).resolves.toBe(true);

    asyncStore.set(KEY, 'true');
    await expect(readLocalMode()).resolves.toBe(false);

    getItem.mockImplementationOnce(async () => {
      throw new Error('native storage unavailable');
    });
    await expect(readLocalMode()).resolves.toBe(false);
  });
});
