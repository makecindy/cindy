/**
 * useDeviceProviders 的 deviceId-aware 缓存单测(device-link「以被控端为准」)。
 * 守住:按 deviceId 隔离、inflight 去重、缓存命中不重拉、evict 只清该设备、evict 在途结果
 * 丢弃不复活、reject 不缓存下次重试 —— 对齐桌面 deviceProvidersCache.test。
 * 模块级缓存:每个用例 vi.resetModules() + 动态 import 拿干净模块。fetcher 注入,无需 stub 全局。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers/registry';

beforeEach(() => {
  vi.resetModules();
});

type Providers = { providers: ProviderView[] };
const result = (deviceId: string): Providers =>
  ({ providers: [{ id: `${deviceId}-xd` } as ProviderView] });

describe('useDeviceProviders deviceId-aware cache', () => {
  it('首次 fetch 调用注入的 fetcher', async () => {
    const fetcher = vi.fn(async () => result('dev-1'));
    const mod = await import('@/device-link/deviceProvidersCache');
    const providers = await mod.fetchDeviceProviders('dev-1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(providers).toEqual({ providers: [{ id: 'dev-1-xd' }] });
  });

  it('被控端回传 modelVisibilityOverrides 时原样入缓存(手机据此过滤模型列表)', async () => {
    const overrides = { 'codex:xd:gpt-5.4': false };
    const fetcher = vi.fn(async () => ({ ...result('dev-1'), modelVisibilityOverrides: overrides }));
    const mod = await import('@/device-link/deviceProvidersCache');
    const payload = await mod.fetchDeviceProviders('dev-1', fetcher);
    expect(payload.modelVisibilityOverrides).toEqual(overrides);
    expect(mod.getCachedDeviceProviders('dev-1')?.modelVisibilityOverrides).toEqual(overrides);
  });

  it('缓存命中:同设备二次 fetch 不再发请求', async () => {
    const fetcher = vi.fn(async () => result('dev-1'));
    const mod = await import('@/device-link/deviceProvidersCache');
    await mod.fetchDeviceProviders('dev-1', fetcher);
    await mod.fetchDeviceProviders('dev-1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('inflight 去重:同设备并发只发一次', async () => {
    const fetcher = vi.fn(async () => result('dev-1'));
    const mod = await import('@/device-link/deviceProvidersCache');
    await Promise.all([
      mod.fetchDeviceProviders('dev-1', fetcher),
      mod.fetchDeviceProviders('dev-1', fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('key 隔离:dev-1 / dev-2 各拉各的,互不影响', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const f1 = vi.fn(async () => result('dev-1'));
    const f2 = vi.fn(async () => result('dev-2'));
    await mod.fetchDeviceProviders('dev-1', f1);
    await mod.fetchDeviceProviders('dev-2', f2);
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
    // dev-2 已缓存:再 fetch 不重拉(隔离 + 命中)。
    await mod.fetchDeviceProviders('dev-2', f2);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('驱逐:evict 后同设备重新拉取;只清该设备(dev-2 仍命中缓存)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const f1 = vi.fn(async () => result('dev-1'));
    const f2 = vi.fn(async () => result('dev-2'));
    await mod.fetchDeviceProviders('dev-1', f1);
    await mod.fetchDeviceProviders('dev-2', f2);
    mod.evictDeviceProviders('dev-1');
    await mod.fetchDeviceProviders('dev-1', f1); // 缓存已清 → 重拉(+1)
    await mod.fetchDeviceProviders('dev-2', f2); // 未清 → 命中(+0)
    expect(f1).toHaveBeenCalledTimes(2);
    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('evict 在途 fetch → 结果丢弃,不复活缓存', async () => {
    const resolvers: Array<(v: Providers) => void> = [];
    const fetcher = vi.fn(() => new Promise<Providers>((r) => resolvers.push(r)));
    const mod = await import('@/device-link/deviceProvidersCache');

    const p = mod.fetchDeviceProviders('dev-1', fetcher); // 在途(未 resolve)
    mod.evictDeviceProviders('dev-1'); // 设备切换 → 驱逐(代际自增)
    resolvers.forEach((r) => r(result('dev-1-stale'))); // 在途请求随后才回来
    await p;

    // 被驱逐的在途结果不得回写缓存 → 再 fetch 必须重新发请求(总计 2 次)。
    const p2 = mod.fetchDeviceProviders('dev-1', fetcher);
    resolvers.forEach((r) => r(result('dev-1-fresh')));
    await p2;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reject(旧版被控端不识别通道)→ 不缓存,下次重试', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("channel 'maker:provider:list' not allowed remotely");
    });
    const mod = await import('@/device-link/deviceProvidersCache');
    await expect(mod.fetchDeviceProviders('dev-old', fetcher)).rejects.toThrow();
    await expect(mod.fetchDeviceProviders('dev-old', fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('clearAll:登出后全部设备缓存清空,各自重拉(防跨账号串数据)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const f1 = vi.fn(async () => result('dev-1'));
    const f2 = vi.fn(async () => result('dev-2'));
    await mod.fetchDeviceProviders('dev-1', f1);
    await mod.fetchDeviceProviders('dev-2', f2);
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'dev-1-xd' }] });

    mod.clearAllDeviceProviders();
    expect(mod.getCachedDeviceProviders('dev-1')).toBeUndefined();
    expect(mod.getCachedDeviceProviders('dev-2')).toBeUndefined();

    await mod.fetchDeviceProviders('dev-1', f1); // 缓存已清 → 重拉
    await mod.fetchDeviceProviders('dev-2', f2);
    expect(f1).toHaveBeenCalledTimes(2);
    expect(f2).toHaveBeenCalledTimes(2);
  });

  it('clearAll 在途 fetch → 结果丢弃,不复活缓存(代际作废)', async () => {
    const resolvers: Array<(v: Providers) => void> = [];
    const fetcher = vi.fn(() => new Promise<Providers>((r) => resolvers.push(r)));
    const mod = await import('@/device-link/deviceProvidersCache');

    const p = mod.fetchDeviceProviders('dev-1', fetcher); // 在途(未 resolve)
    mod.clearAllDeviceProviders(); // 登出 → 全清 + 代际自增
    resolvers.forEach((r) => r(result('dev-1-stale'))); // 在途请求随后才回来
    await p;

    expect(mod.getCachedDeviceProviders('dev-1')).toBeUndefined();
    const p2 = mod.fetchDeviceProviders('dev-1', fetcher);
    resolvers.forEach((r) => r(result('dev-1-fresh')));
    await p2;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('新快照只通知对应 deviceId 的已挂载订阅者', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const dev1 = vi.fn();
    const dev2 = vi.fn();
    const off1 = mod.subscribeDeviceProviders('dev-1', dev1);
    const off2 = mod.subscribeDeviceProviders('dev-2', dev2);

    await mod.fetchDeviceProviders('dev-1', async () => result('dev-1'));
    expect(dev1).toHaveBeenCalledWith({ providers: [{ id: 'dev-1-xd' }] });
    expect(dev2).not.toHaveBeenCalled();

    off1();
    off2();
  });

  it('revision 后新请求先完成、旧请求后完成时只通知新快照', async () => {
    const resolvers: Array<(value: Providers) => void> = [];
    const fetcher = vi.fn(() => new Promise<Providers>((resolve) => resolvers.push(resolve)));
    const mod = await import('@/device-link/deviceProvidersCache');
    const listener = vi.fn();
    mod.subscribeDeviceProviders('dev-1', listener);

    const stale = mod.fetchDeviceProviders('dev-1', fetcher);
    mod.evictDeviceProviders('dev-1');
    const fresh = mod.fetchDeviceProviders('dev-1', fetcher);
    resolvers[1](result('fresh'));
    await fresh;
    resolvers[0](result('stale'));
    await stale;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ providers: [{ id: 'fresh-xd' }] });
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'fresh-xd' }] });
  });

  it('getDeviceProvidersGen:evict / clearAll 自增代际,其他设备不受影响(codex P2 ready 代际)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const gen0 = mod.getDeviceProvidersGen('dev-1');
    mod.evictDeviceProviders('dev-1');
    expect(mod.getDeviceProvidersGen('dev-1')).toBe(gen0 + 1);
    // 重拉完成不进一步提升代际(代际只随驱逐前进,置位时记录即稳定)
    await mod.fetchDeviceProviders('dev-1', async () => result('dev-1'));
    expect(mod.getDeviceProvidersGen('dev-1')).toBe(gen0 + 1);
    mod.evictDeviceProviders('dev-1');
    expect(mod.getDeviceProvidersGen('dev-1')).toBe(gen0 + 2);
    // clearAll 只自增代际表内设备;从未有缓存活动的设备不受影响
    const gen2 = mod.getDeviceProvidersGen('dev-2');
    mod.clearAllDeviceProviders();
    expect(mod.getDeviceProvidersGen('dev-1')).toBe(gen0 + 3);
    expect(mod.getDeviceProvidersGen('dev-2')).toBe(gen2);
  });
});
