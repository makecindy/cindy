/**
 * deviceProvidersCache —— 被控端供应商目录的 deviceId-aware 缓存核心(**纯逻辑,零 react-native**)。
 *
 * 刻意不 import react-native / hook,便于 node 环境单测直接验证缓存语义(对齐 tokens.ts /
 * monoFont.ts 的拆分约定)。React hook 在 `./useDeviceProviders.ts` 里消费本模块。
 *
 * 语义对齐桌面 `useDeviceProviders`:按 deviceId 隔离 + inflight 去重 + 代际驱逐
 * (evict 时自增代际,作废在途 fetch 的回写,防设备切换 / 重连后串旧供应商)。
 */
import type { ProviderView } from '@cindy/model-providers/registry';

/** PROVIDER_LIST 隧道回包:目录 + 被控端「模型显示/隐藏」override 快照(旧被控端无)。 */
export interface DeviceProvidersPayload {
  providers: ProviderView[];
  /** key = `${agent}:${providerId}:${modelId}`;undefined = 旧被控端,调用方不过滤。 */
  modelVisibilityOverrides?: Record<string, boolean>;
}

/** 被控端供应商目录的取数器(通常 = `() => transport.listProviders()`)。 */
export type DeviceProvidersFetcher = () => Promise<DeviceProvidersPayload>;

// 缓存按被控设备隔离;代际同桌面(evict 时自增,作废在途 fetch 的回写)。
const cache = new Map<string, DeviceProvidersPayload>();
const inflight = new Map<string, Promise<DeviceProvidersPayload>>();
const deviceGen = new Map<string, number>();
const listeners = new Map<string, Set<(payload: DeviceProvidersPayload) => void>>();

function notifyDeviceProviders(deviceId: string, payload: DeviceProvidersPayload): void {
  for (const listener of listeners.get(deviceId) ?? []) listener(payload);
}

/** 订阅某设备缓存的新快照；provider revision push 刷新后通知已挂载 hook。 */
export function subscribeDeviceProviders(
  deviceId: string,
  listener: (payload: DeviceProvidersPayload) => void,
): () => void {
  const bucket = listeners.get(deviceId) ?? new Set<(payload: DeviceProvidersPayload) => void>();
  bucket.add(listener);
  listeners.set(deviceId, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) listeners.delete(deviceId);
  };
}

/** 读缓存命中(同步),供 hook 初始化 state 用。 */
export function getCachedDeviceProviders(deviceId: string): DeviceProvidersPayload | undefined {
  return cache.get(deviceId);
}

/**
 * 取某被控设备的供应商目录(带缓存 + inflight 去重 + 代际作废)。纯逻辑、可单测。
 * fetcher 注入,便于按 deviceId 绑定 transport,也便于测试。
 */
export async function fetchDeviceProviders(
  deviceId: string,
  fetcher: DeviceProvidersFetcher,
): Promise<DeviceProvidersPayload> {
  const cached = cache.get(deviceId);
  if (cached) return cached;
  const ip = inflight.get(deviceId);
  if (ip) return ip;

  // 捕获发起时代际;回调里若代际已变(被 evict)则认为本次请求作废,不回写 cache / 不动 inflight。
  const startGen = deviceGen.get(deviceId) ?? 0;
  const isCurrent = (): boolean => (deviceGen.get(deviceId) ?? 0) === startGen;

  const p = fetcher()
    .then((res) => {
      const payload: DeviceProvidersPayload = {
        providers: res?.providers ?? [],
        ...(res?.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: res.modelVisibilityOverrides }
          : {}),
      };
      if (isCurrent()) {
        cache.set(deviceId, payload);
        inflight.delete(deviceId);
        notifyDeviceProviders(deviceId, payload);
      }
      return payload;
    })
    .catch((e) => {
      if (isCurrent()) inflight.delete(deviceId);
      throw e;
    });
  inflight.set(deviceId, p);
  return p;
}

/**
 * 强制刷新取某被控设备的供应商目录(codex review P2):**跳过缓存命中短路**——
 * 即使缓存仍存在也执行 fetcher 访问工作站,成功后回写缓存并推送 payload 订阅者。
 * 用途:提交终检的 revalidate(缓存命中分支要拿到工作站当前真相,而不是旧目录),
 * 与普通读取的 cache-first 语义区分。
 * 不复用普通 fetch 的在途请求(greptile review P1):普通请求可能发起于工作站目录
 * 变更之前、本地代际尚未递增——fresh 语义是「强制访问工作站拿当前真相」,join
 * 旧请求会拿过期目录当已知目录。fresh 自身并发仍经独立 inflight 槽去重。
 */
const freshInflight = new Map<string, Promise<DeviceProvidersPayload>>();

export async function fetchDeviceProvidersFresh(
  deviceId: string,
  fetcher: DeviceProvidersFetcher,
): Promise<DeviceProvidersPayload> {
  const fp = freshInflight.get(deviceId);
  if (fp) return fp;

  // fresh 语义 = 强制访问工作站拿当前真相。仅当确有普通请求在途时才作废它
  // (greptile/copilot/codex review P1/P2):旧普通请求若在 fresh 之后返回,仍会
  // 通过 isCurrent() 回写旧目录覆盖 fresh 结果——代际 +1 使更早请求失效并清掉
  // 普通 inflight 槽。**无普通在途时不得推进代际**(codex review P2):守卫
  // resolveSubmitGuardCatalog 在 fetch 前记录 genAt,fresh 自推进会让守卫误判
  // 为外部驱逐而丢弃结果;仅在确有在途时推进,守卫下一轮重跑(普通在途已清)
  // 即收敛,gen 保持稳定时 fetch 前后一致直接采信。
  const ip = inflight.get(deviceId);
  if (ip) {
    inflight.delete(deviceId);
    deviceGen.set(deviceId, (deviceGen.get(deviceId) ?? 0) + 1);
    notifyDeviceProvidersGen(deviceId);
  }

  const startGen = deviceGen.get(deviceId) ?? 0;
  const isCurrent = (): boolean => (deviceGen.get(deviceId) ?? 0) === startGen;

  const p = fetcher()
    .then((res) => {
      const payload: DeviceProvidersPayload = {
        providers: res?.providers ?? [],
        ...(res?.modelVisibilityOverrides !== undefined
          ? { modelVisibilityOverrides: res.modelVisibilityOverrides }
          : {}),
      };
      if (isCurrent()) {
        cache.set(deviceId, payload);
        notifyDeviceProviders(deviceId, payload);
      }
      return payload;
    })
    .catch((e) => {
      // 失败分支不动普通 inflight:那是 cache-first 槽,fresh 不写它也不该清它
      // (copilot review P1)。freshInflight 由下方 finally 清理。
      throw e;
    });
  freshInflight.set(deviceId, p);
  void p.finally(() => {
    if (freshInflight.get(deviceId) === p) freshInflight.delete(deviceId);
  }).catch(() => undefined);
  return p;
}

/** device-link:被控设备切换 / 下线时驱逐其供应商缓存(只清该设备 + 代际自增作废在途)。 */
export function evictDeviceProviders(deviceId: string): void {
  cache.delete(deviceId);
  inflight.delete(deviceId);
  freshInflight.delete(deviceId);
  deviceGen.set(deviceId, (deviceGen.get(deviceId) ?? 0) + 1);
  notifyDeviceProvidersGen(deviceId);
}

/**
 * 读某设备当前的缓存代际(evict 一次 +1)。useDeviceProviders 的 ready 判定用:
 * 置位 readyFor 时记录当时代际,之后代际不一致 = 目录已被驱逐、正在重拉(或重拉失败),
 * ready 必须为 false —— 否则旧 payload 会在重拉窗口期继续被当作就绪目录(codex review P2)。
 */
export function getDeviceProvidersGen(deviceId: string): number {
  return deviceGen.get(deviceId) ?? 0;
}

// ── 代际变更订阅 ────────────────────────────────────────────────────────────
// evict/clearAll 只改模块级 Map,不通知 payload 订阅者,React 不会重渲染 ——
// 单靠渲染期的代际比对,ready 的失效要等下一次碰巧渲染(codex review P2)。
// 这里给代际变化一条主动推送通道,hook 收到即立即使 ready 失效。
const genListeners = new Map<string, Set<() => void>>();

/** 订阅某设备的缓存代际变更(evict/clearAll 时触发);返回退订函数。 */
export function subscribeDeviceProvidersGen(deviceId: string, listener: () => void): () => void {
  const bucket = genListeners.get(deviceId) ?? new Set<() => void>();
  bucket.add(listener);
  genListeners.set(deviceId, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) genListeners.delete(deviceId);
  };
}

function notifyDeviceProvidersGen(deviceId: string): void {
  for (const listener of genListeners.get(deviceId) ?? []) listener();
}

/**
 * 账号登出 / 进程内切号时清空**全部**被控设备的供应商缓存。
 *
 * 这是 module 级单例缓存,不随 React 组件卸载清空。若不在登出时清,下一个登录账号会通过
 * `getCachedDeviceProviders` 命中上一个账号留下的被控端供应商目录(跨账号串数据)。除清
 * cache / inflight 外,对每个已知 deviceId 自增代际,作废所有仍在途 fetch 的回写,防其在
 * clear 之后又把旧数据写回。
 */
export function clearAllDeviceProviders(): void {
  // fresh-only 在途设备也要纳入代际作废(greptile/copilot/codex review P1/P2):
  // 只有 freshInflight 在途时(如提交终检触发的 fresh 拉取),登出后旧响应仍会
  // 通过 isCurrent() 回写并广播,造成跨账号残留。
  const ids = new Set<string>([
    ...cache.keys(),
    ...inflight.keys(),
    ...freshInflight.keys(),
    ...deviceGen.keys(),
  ]);
  for (const id of ids) {
    deviceGen.set(id, (deviceGen.get(id) ?? 0) + 1);
    notifyDeviceProvidersGen(id);
    // 登出/切号也要清空 payload 订阅者(copilot review P2):只清 module 缓存 + 代际
    // 通知,已挂载的 useDeviceProviders 仍保留旧 payload 在 React state——推送空
    // payload 让 hook 立即清空,消除登出后短窗口残留上一账号供应商信息。
    notifyDeviceProviders(id, { providers: [] });
  }
  cache.clear();
  inflight.clear();
  freshInflight.clear();
}
