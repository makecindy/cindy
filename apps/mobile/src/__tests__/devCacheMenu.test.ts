import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mobile vitest 跑在 node 环境(无 react-native / 无 __DEV__):mock 掉 react-native 的 DevSettings + 两层 cache 清理,
// 再用 globalThis.__DEV__ 控制 gate,执行型验证三个不变量:生产不可达 / 防重复注册 / handler 真的清缓存 + reload。
vi.mock('react-native', () => ({
  DevSettings: { addMenuItem: vi.fn(), reload: vi.fn() },
}));
vi.mock('@/session/mobileSessionMessageCache', () => ({
  clearCachedSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

// 每个用例拿一份全新模块图(devCacheMenu 模块级 registered 标记 + 全新 mock 实例),互不污染。
async function loadFresh(dev: boolean) {
  vi.resetModules();
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
  const rn = await import('react-native');
  const messageCache = await import('@/session/mobileSessionMessageCache');
  const mod = await import('@/debug/devCacheMenu');
  return {
    addMenuItem: vi.mocked(rn.DevSettings.addMenuItem),
    reload: vi.mocked(rn.DevSettings.reload),
    clearCachedSessionMessages: vi.mocked(messageCache.clearCachedSessionMessages),
    registerDevCacheMenu: mod.registerDevCacheMenu,
  };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe('registerDevCacheMenu (dev-only debug entry — runtime gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete (globalThis as unknown as { __DEV__?: boolean }).__DEV__;
  });

  it('is unreachable in production: __DEV__=false → addMenuItem is never called', async () => {
    const { addMenuItem, registerDevCacheMenu } = await loadFresh(false);
    registerDevCacheMenu();
    expect(addMenuItem).not.toHaveBeenCalled();
  });

  it('registers exactly once in dev, and re-invoking (Fast-Refresh) does not register again', async () => {
    const { addMenuItem, registerDevCacheMenu } = await loadFresh(true);
    registerDevCacheMenu();
    registerDevCacheMenu();
    registerDevCacheMenu();
    expect(addMenuItem).toHaveBeenCalledTimes(1);
    expect(addMenuItem).toHaveBeenCalledWith('🧹 Clear session caches & reload', expect.any(Function));
  });

  it('the registered handler clears both caches then reloads', async () => {
    const {
      addMenuItem,
      reload,
      clearCachedSessionMessages,
      registerDevCacheMenu,
    } = await loadFresh(true);
    registerDevCacheMenu();
    const handler = addMenuItem.mock.calls[0][1] as () => void;
    handler();
    await flushMicrotasks();
    expect(clearCachedSessionMessages).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
