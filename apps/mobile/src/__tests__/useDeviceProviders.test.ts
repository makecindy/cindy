/**
 * useDeviceProviders 的 deviceId-aware 缓存单测(device-link「以被控端为准」)。
 * 守住:按 deviceId 隔离、inflight 去重、缓存命中不重拉、evict 只清该设备、evict 在途结果
 * 丢弃不复活、reject 不缓存下次重试 —— 对齐桌面 deviceProvidersCache.test。
 * 模块级缓存:每个用例 vi.resetModules() + 动态 import 拿干净模块。fetcher 注入,无需 stub 全局。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers/registry';

const readTextLf = (path: string, encoding: BufferEncoding): string =>
  readFileSync(path, encoding).toString().replace(/\r\n/g, '\n');

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

  it('fetchDeviceProvidersFresh:缓存命中也执行 fetcher 访问工作站,成功后回写缓存(codex P2)', async () => {
    const fetcher = vi.fn(async () => result('dev-1-new'));
    const mod = await import('@/device-link/deviceProvidersCache');
    // 先普通读取填缓存(缓存命中不再发请求)
    await mod.fetchDeviceProviders('dev-1', vi.fn(async () => result('dev-1-old')));
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'dev-1-old-xd' }] });
    // 强制刷新:即使缓存仍在,也必须访问工作站
    const fresh = await mod.fetchDeviceProvidersFresh('dev-1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fresh).toEqual({ providers: [{ id: 'dev-1-new-xd' }] });
    // 成功后回写缓存(后续普通读取拿新目录)
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'dev-1-new-xd' }] });
  });

  it('fetchDeviceProvidersFresh 失败:不覆盖缓存,抛错由调用方回退', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    await mod.fetchDeviceProviders('dev-1', vi.fn(async () => result('dev-1-old')));
    await expect(mod.fetchDeviceProvidersFresh('dev-1', () => Promise.reject(new Error('down'))))
      .rejects.toThrow('down');
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'dev-1-old-xd' }] });
  });

  it('fresh 失败且曾作废普通在途 → 恢复普通拉取,目录不再卡未知(codex P2)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    // 普通请求在途(发起时目录 A)
    const ordinaryResolvers: Array<(v: Providers) => void> = [];
    const ordinary = vi.fn(() => new Promise<Providers>((r) => ordinaryResolvers.push(r)));
    void mod.fetchDeviceProviders('dev-1', ordinary);
    // fresh 触发并失败(瞬断)
    const freshFetcher = vi.fn(() => Promise.reject(new Error('transient down')));
    await expect(mod.fetchDeviceProvidersFresh('dev-1', freshFetcher)).rejects.toThrow('transient down');
    // 恢复拉取:cache-first 重新发起(有缓存立即恢复已知 / 无缓存访问工作站)
    const recoveryFetcher = vi.fn(async () => result('dev-1-recovered'));
    // 等待 fire-and-forget 恢复请求落定(经 inflight 槽,reject 后槽已清)
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 恢复请求应已发出并回写缓存(hook 不再停在 ready=false 未知态)
    await mod.fetchDeviceProviders('dev-1', recoveryFetcher);
    expect(recoveryFetcher).toHaveBeenCalled();
  });

  it('fetchDeviceProvidersFresh 无普通在途时不推进代际:守卫 genAt 校验可直接采信(codex P2)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const genBefore = mod.getDeviceProvidersGen('dev-1');
    const fetcher = vi.fn(async () => result('dev-1'));
    await mod.fetchDeviceProvidersFresh('dev-1', fetcher);
    // 无普通在途 → 不得自推进代际(否则守卫把 fresh 自推进误判为外部驱逐而丢结果)
    expect(mod.getDeviceProvidersGen('dev-1')).toBe(genBefore);
  });

  it('fetchDeviceProvidersFresh 有普通在途时推进代际:旧普通请求后返回不回写覆盖 fresh(greptile P1)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    // 普通请求挂起(发起时目录为 A)
    const ordinaryResolvers: Array<(v: Providers) => void> = [];
    const ordinary = vi.fn(() => new Promise<Providers>((r) => ordinaryResolvers.push(r)));
    const ordinaryP = mod.fetchDeviceProviders('dev-1', ordinary);
    // fresh 在普通请求在途时发起(强制访问工作站,拿到 B)
    const freshResolvers: Array<(v: Providers) => void> = [];
    const freshFetcher = vi.fn(() => new Promise<Providers>((r) => freshResolvers.push(r)));
    const freshP = mod.fetchDeviceProvidersFresh('dev-1', freshFetcher);
    expect(freshFetcher).toHaveBeenCalledTimes(1);
    freshResolvers.forEach((r) => r(result('dev-1-fresh')));
    await freshP;
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'dev-1-fresh-xd' }] });
    // 旧普通请求随后返回 A → 代际已变,不得回写覆盖 fresh
    ordinaryResolvers.forEach((r) => r(result('dev-1-stale')));
    await ordinaryP;
    expect(mod.getCachedDeviceProviders('dev-1')).toEqual({ providers: [{ id: 'dev-1-fresh-xd' }] });
  });

  it('clearAll 纳入 fresh-only 在途设备:登出后 fresh 响应不回写跨账号残留(greptile/copilot P1)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const freshResolvers: Array<(v: Providers) => void> = [];
    const freshFetcher = vi.fn(() => new Promise<Providers>((r) => freshResolvers.push(r)));
    // 无普通缓存/在途,只有 fresh 在途(提交终检触发)
    const freshP = mod.fetchDeviceProvidersFresh('dev-1', freshFetcher);
    mod.clearAllDeviceProviders(); // 登出 → fresh-only 设备也要代际作废
    freshResolvers.forEach((r) => r(result('dev-1-old-account')));
    await freshP;
    // 旧账号 fresh 响应不得回写缓存(代际已变)
    expect(mod.getCachedDeviceProviders('dev-1')).toBeUndefined();
  });

  it('clearAll:不向 payload 订阅者推送空载荷(防误标就绪),仅代际失效(codex review P2)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const f1 = vi.fn(async () => result('dev-1'));
    await mod.fetchDeviceProviders('dev-1', f1);
    const subscriber = vi.fn();
    const unsub = mod.subscribeDeviceProviders('dev-1', subscriber);
    mod.clearAllDeviceProviders();
    // payload 订阅是「确认快照」通道:推送空载荷会把 readyFor 误置为就绪。
    // 清空展示与未就绪改由 gen 失效订阅承担(hook 侧),此处不得再推送。
    expect(subscriber).not.toHaveBeenCalled();
    unsub();
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

  it('缓存所属连接代际持久化到模块级:组件卸载不丢,旧设备仍判重连(codex P1)', async () => {
    // reconnected 判定必须按 deviceId 记录「缓存写入时的连接代际」,且存模块级
    // (组件本地 ref 会随卸载丢失)——重连时 hook 未挂载,旧设备再打开若被当首次
    // 挂载会采信断线前缓存,断线期间改过的供应商永远不被刷新(codex review P1)。
    const src = readTextLf(resolve(process.cwd(), 'src/device-link/useDeviceProviders.ts'), 'utf8');
    const cacheSrc = readTextLf(resolve(process.cwd(), 'src/device-link/deviceProvidersCache.ts'), 'utf8');
    const ctxSrc = readTextLf(resolve(process.cwd(), 'src/device-link/DeviceLinkContext.tsx'), 'utf8');
    // hook 从模块级缓存读取/标记代际(不持有组件本地 ref)
    expect(src).toContain('const prevEpoch = getDeviceFetchEpoch(deviceId);');
    expect(src).toContain('const reconnected = prevEpoch !== undefined && prevEpoch !== connectionEpoch;');
    expect(src).toContain('markDeviceFetchEpoch(deviceId, connectionEpoch);');
    // 首帧 readyFor 初始化同步核对连接代际(codex P2):重连后 hook 重挂载,缓存属
    // 旧 epoch 时首帧保持未就绪,避免外层 auto-default 按旧目录首行写草稿。
    expect(src).toContain('const cachedAtEpoch = getDeviceFetchEpoch(deviceId);');
    expect(src).toContain('cachedAtEpoch !== undefined && cachedAtEpoch !== connectionEpoch) return null;');
    // mark 只在成功路径:effect 开头(reconnected 判定后)不得无条件 mark——否则
    // refresh 失败后同 epoch 重挂载会把断线前旧缓存判「未重连」直接就绪且不重试
    const reconnectedBlock = src.slice(
      src.indexOf('const prevEpoch = getDeviceFetchEpoch(deviceId);'),
      src.indexOf('const prevEpoch = getDeviceFetchEpoch(deviceId);') + 300,
    );
    expect(reconnectedBlock).not.toContain('markDeviceFetchEpoch');
    // 无挂载 hook 的后台缓存写入路径(DeviceLinkContext provider:changed)也必须
    // mark epoch——否则断线前旧目录被当「首次挂载缓存命中」采信、永不刷新
    // (codex review P1)。捕获 epoch 在 fetch 前、mark 在成功后(失败不 mark)。
    expect(ctxSrc).toContain('const epochAtWrite = connectionEpoch;');
    expect(ctxSrc).toContain('markDeviceFetchEpoch(deviceId, epochAtWrite);');
    const ctxBlock = ctxSrc.slice(
      ctxSrc.indexOf('onProviderChanged: (deviceId) => {'),
      ctxSrc.indexOf('onProviderChanged: (deviceId) => {') + 1400,
    );
    expect(ctxBlock).toContain('.then(() => {');
    expect(ctxBlock).toContain('markDeviceFetchEpoch(deviceId, epochAtWrite);');
    // 模块级 Map + 导出存取(跨组件卸载存活)
    expect(cacheSrc).toContain('const deviceFetchEpoch = new Map<string, number>();');
    expect(cacheSrc).toContain('export function markDeviceFetchEpoch(deviceId: string, epoch: number): void');
    expect(cacheSrc).toContain('export function getDeviceFetchEpoch(deviceId: string): number | undefined');
    // 不再有组件本地单值/Map ref 判定
    expect(src).not.toMatch(/prevEpochRef|prevEpochsRef/);
  });

  it('多 peer 故障隔离:dev-1 fresh 拉取失败,dev-2 缓存零感知(fault-radius 三问)', async () => {
    // 故障半径三问的多 peer 用例:恢复路径改动必须带「≥2 控制端共享同一被控端,
    // 一个 peer 静默/失败,其它 peer 零感知」——dev-1 fresh 失败只作用于 dev-1
    // 自身(不覆盖缓存、不推进代际),dev-2 的缓存命中与代际不受波及。
    const mod = await import('@/device-link/deviceProvidersCache');
    const dev2Fetcher = vi.fn(async () => result('dev-2'));
    await mod.fetchDeviceProviders('dev-2', dev2Fetcher);
    const dev2Gen = mod.getDeviceProvidersGen('dev-2');
    // dev-1 fresh 拉取失败(网络/工作站问题):不覆盖 dev-1 缓存,抛错由调用方回退
    await expect(mod.fetchDeviceProvidersFresh('dev-1', vi.fn(async () => {
      throw new Error('NETWORK_DOWN');
    }))).rejects.toThrow('NETWORK_DOWN');
    // dev-2 零感知:缓存仍命中(不发新请求)、代际未被 dev-1 的失败推进
    await mod.fetchDeviceProviders('dev-2', vi.fn(async () => result('dev-2-should-not-be-used')));
    expect(dev2Fetcher).toHaveBeenCalledTimes(1);
    expect(mod.getCachedDeviceProviders('dev-2')).toEqual({ providers: [{ id: 'dev-2-xd' }] });
    expect(mod.getDeviceProvidersGen('dev-2')).toBe(dev2Gen);
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

  it('subscribeDeviceProvidersGen:evict/clearAll 主动通知,fetch 完成不通知(codex P2)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const dev1 = vi.fn();
    const dev2 = vi.fn();
    const off1 = mod.subscribeDeviceProvidersGen('dev-1', dev1);
    const off2 = mod.subscribeDeviceProvidersGen('dev-2', dev2);

    // fetch 完成(写缓存 + payload 通知)不触发代际通知
    await mod.fetchDeviceProviders('dev-1', async () => result('dev-1'));
    expect(dev1).not.toHaveBeenCalled();

    // evict 触发对应设备的代际通知(原因 evict),不影响其他设备
    mod.evictDeviceProviders('dev-1');
    expect(dev1).toHaveBeenCalledWith('evict');
    expect(dev2).not.toHaveBeenCalled();

    // clearAll 通知代际表内所有设备(原因 evict),且发生在缓存清空之后
    mod.evictDeviceProviders('dev-2');
    dev1.mockClear();
    dev2.mockClear();
    const cacheAtNotify: unknown[] = [];
    const offProbe = mod.subscribeDeviceProvidersGen('dev-1', () => {
      cacheAtNotify.push(mod.getCachedDeviceProviders('dev-1'));
    });
    mod.clearAllDeviceProviders();
    expect(dev1).toHaveBeenCalledWith('evict');
    expect(dev2).toHaveBeenCalledWith('evict');
    // 通知时缓存已清空(hook 收到后重拉不会命中旧账号缓存——codex review P2)
    expect(cacheAtNotify).toContain(undefined);
    offProbe();

    // 退订后不再通知
    off1();
    off2();
    mod.evictDeviceProviders('dev-1');
    expect(dev1).toHaveBeenCalledTimes(1);
  });

  it('fresh 作废普通在途:代际通知原因 fresh-invalidate(fresh 自身恢复,hook 不得重拉)', async () => {
    const mod = await import('@/device-link/deviceProvidersCache');
    const listener = vi.fn();
    const off = mod.subscribeDeviceProvidersGen('dev-1', listener);
    // 普通请求在途时启动 fresh → 作废普通在途,通知原因 fresh-invalidate
    const resolvers: Array<(v: Providers) => void> = [];
    const fetcher = vi.fn(() => new Promise<Providers>((r) => resolvers.push(r)));
    const freshResolvers: Array<(v: Providers) => void> = [];
    const freshFetcher = vi.fn(() => new Promise<Providers>((r) => freshResolvers.push(r)));
    void mod.fetchDeviceProviders('dev-1', fetcher); // 普通在途
    void mod.fetchDeviceProvidersFresh('dev-1', freshFetcher); // fresh 作废普通
    expect(listener).toHaveBeenCalledWith('fresh-invalidate');
    // 完成两条请求后,缓存最终为 fresh 结果(普通被作废不回写)
    freshResolvers.forEach((r) => r(result('dev-1-fresh')));
    await new Promise((r) => setTimeout(r, 0));
    resolvers.forEach((r) => r(result('dev-1-stale')));
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.getCachedDeviceProviders('dev-1')?.providers[0]?.id).toBe('dev-1-fresh-xd');
    off();
  });
});

describe('fetchDeviceProvidersFresh 恢复分支 (source locks)', () => {
  it('fresh 失败恢复时缓存命中 → 主动重发快照(codex P2:缓存命中分支必须发布,否则 hook ready 一直未知)', () => {
    // 行为时序「缓存有值 + 普通在途」在轮次 37 修复后互斥不可黑盒构造,用 source-lock
    // 守住恢复分支的两条路径(cache-first 命中 → notify 重发;miss → 重新拉取)。
    const source = readTextLf(
      resolve(process.cwd(), 'src/device-link/deviceProvidersCache.ts'),
      'utf8',
    );
    expect(source).toContain('notifyDeviceProviders(deviceId, cached)');
    expect(source).toContain('void fetchDeviceProviders(deviceId, fetcher).catch(() => undefined)');
  });
});
