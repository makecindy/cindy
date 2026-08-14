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
// 各设备缓存写入时的连接代际(模块级,组件卸载不丢):hook 用它对「重连时未挂载 /
// 正看其它设备」的旧缓存做重连判定(codex review P1)——组件本地 ref 会随卸载
// 丢失,旧设备再打开会被当首次挂载、采信断线前缓存。
const deviceFetchEpoch = new Map<string, number>();

/** hook 在缓存命中 / 拉取完成后标记该设备缓存所属的连接代际。 */
export function markDeviceFetchEpoch(deviceId: string, epoch: number): void {
  deviceFetchEpoch.set(deviceId, epoch);
}

/** 读该设备缓存写入时的连接代际;无记录 = 该设备从未标记(首次挂载语义)。 */
export function getDeviceFetchEpoch(deviceId: string): number | undefined {
  return deviceFetchEpoch.get(deviceId);
}

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
  // 重连期间 fresh 在途时 join fresh(greptile P1:重连请求覆盖 fresh 目录)——
  // connectionEpoch 变化会让 useDeviceProviders 重跑 effect 发起普通请求;该请求
  // 捕获与 fresh 相同的代际,晚于 fresh 返回仍通过 isCurrent() 覆盖共享缓存。
  // fresh 结果即工作站最新真相,普通读取 join 它语义正确且不会产生竞争请求。
  const fp = freshInflight.get(deviceId);
  if (fp) return fp;
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
  // 是否曾作废普通在途:失败时需恢复拉取(copilot review P1 要求失败分支不动
  // 普通 inflight,这里只在启动时作废过一次;记录以便失败后恢复)。
  const invalidatedOrdinary = ip !== undefined;
  if (ip) {
    inflight.delete(deviceId);
    deviceGen.set(deviceId, (deviceGen.get(deviceId) ?? 0) + 1);
    // 内部作废(greptile/codex review P1/P2):hook 不得因此启动替代普通请求——
    // fresh 自身会写缓存并经 payload 订阅恢复;若 hook 重拉普通请求会与 fresh
    // 竞争(同代际、较晚返回仍通过 isCurrent() 把 fresh 结果覆盖回旧目录)。
    notifyDeviceProvidersGen(deviceId, 'fresh-invalidate');
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
      // fresh 失败且曾作废普通在途 → 恢复目录(codex review P2):被作废的普通
      // 请求已因代际失效不回写,hook 会停在 ready=false 不再自动重拉(设备/maker
      // 未变化不触发 effect)。恢复两条路径:
      // - 缓存命中:主动重发快照恢复 hook 的 readyFor/readyGen——fetchDeviceProviders
      //   缓存命中直接返回不触发 payload 订阅回调,fresh 推进的代际已使 ready
      //   失效,不重发则目录一直未知(codex review P2);
      // - 无缓存:真正重新访问工作站。
      // fire-and-forget,不阻塞调用方的 reject。
      if (invalidatedOrdinary) {
        const cached = cache.get(deviceId);
        if (cached) {
          notifyDeviceProviders(deviceId, cached);
        } else if (isCurrent()) {
          // 仅 fresh 所属代际仍有效时才补拉(codex review P2):fresh 请求期间设备
          // 可能已被驱逐/登出/切号(代际已变),此时补拉成功会重新写入已驱逐设备
          // 或上一账号的目录——清理完成后不得复活旧目录。
          // 先清 fresh 槽(codex review P2:在清除 fresh 槽后再启动恢复拉取)——本
          // promise 仍占着 freshInflight(直到下方 p.finally 才删除),fetchDeviceProviders
          // 的 fresh 优先分支会 join 同一个正在 reject 的 promise,fetcher 不会再次
          // 执行,已挂载 hook 停在 ready=false。清槽后恢复调用走正常普通拉取。
          freshInflight.delete(deviceId);
          void fetchDeviceProviders(deviceId, fetcher).catch(() => undefined);
        }
      }
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
  notifyDeviceProvidersGen(deviceId, 'evict');
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
/**
 * 代际失效原因(codex review P2):evict/clearAll 是**外部驱逐**——hook 应清空展示
 * 并主动重拉;fetchDeviceProvidersFresh 作废普通在途是**内部作废**——fresh 自身会
 * 写缓存并经 payload 订阅恢复,若 hook 再启动普通请求会与 fresh 竞争(普通请求
 * 捕获同一代际、较晚返回仍通过 isCurrent() 把 fresh 结果覆盖回旧目录)。
 */
export type DeviceProvidersGenInvalidationReason = 'evict' | 'fresh-invalidate';

const genListeners = new Map<string, Set<(reason: DeviceProvidersGenInvalidationReason) => void>>();

/** 订阅某设备的缓存代际变更(evict/clearAll/fresh 作废时触发);返回退订函数。 */
export function subscribeDeviceProvidersGen(
  deviceId: string,
  listener: (reason: DeviceProvidersGenInvalidationReason) => void,
): () => void {
  const bucket = genListeners.get(deviceId) ?? new Set<(reason: DeviceProvidersGenInvalidationReason) => void>();
  bucket.add(listener);
  genListeners.set(deviceId, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) genListeners.delete(deviceId);
  };
}

function notifyDeviceProvidersGen(
  deviceId: string,
  reason: DeviceProvidersGenInvalidationReason,
): void {
  for (const listener of genListeners.get(deviceId) ?? []) listener(reason);
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
  // 先清空三张 Map,再通知(codex review P2:清空缓存后再通知订阅者)——hook 的
  // gen 订阅收到 'evict' 会立即 fetchDeviceProviders 重拉,若通知发生在清空之前,
  // 重拉只会命中旧账号缓存或加入旧请求,随后 Map 被清掉,既没真正访问新账号,
  // 也没有 payload 通知恢复 hook,目录长期停在 ready=false。
  cache.clear();
  inflight.clear();
  freshInflight.clear();
  for (const id of ids) {
    deviceGen.set(id, (deviceGen.get(id) ?? 0) + 1);
    notifyDeviceProvidersGen(id, 'evict');
    // 注意:不再推送空 payload(codex review P2:清空账号缓存时不要把空载荷标为
    // 就绪)——payload 订阅回调把任何 payload 视为已确认快照,会重新置位
    // readyFor/readyGen,最终暴露为 ready:true 的 loaded-empty 目录;且
    // [deviceId, maker] effect 不因重新登录重跑,新账号目录永不重拉。清空展示
    // 与未就绪由 hook 的 gen 失效订阅承担(清 payload + 保持未就绪 + 主动重拉),
    // 见 useDeviceProviders。登出后短窗口残留由该订阅的清空兜底(copilot P2 意图)。
  }
}
