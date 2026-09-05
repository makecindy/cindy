/**
 * useAvailableAgents — 当前会话上下文里**运行时已注册**的 agent 集合。
 *
 * 为什么需要:Pi 的二进制经 postinstall best-effort 下载,可能失败/开发环境未装/当前
 * 平台无资产 → `buildPiAgent()` 返回 null → maker 的 agent map 里没有 `pi`。但 provider
 * 模型目录仍会照常投影 Pi 模型,创建入口若只看目录就会让用户一路创建,最终在
 * `Maker.requireAgent()` 撞上 `Agent 'pi' is not registered`(codex review P2)。
 * 权威来源是 `maker:list-available-agents`(runtime 注册结果),不是模型目录。
 *
 * device-link:远程草稿的可用性以**被控端**为准 —— 传 deviceId 时走隧道 invoke
 * (channel 在 REMOTE_INVOKE_ALLOWLIST 内)。省略 = 本机。
 *
 * 加载语义:未加载完成时 `loaded=false` 且 `availableVendors` 为空;消费方必须把
 * "未加载" 当作 "先别隐藏任何入口"(避免异步 fetch 期间误隐藏合法 agent)。
 */
import { useEffect, useState } from 'react';

import type { MakerVendor } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import {
  evictDeviceCapabilities,
  prefetchDeviceCapabilities,
  refreshLocalCapabilities,
} from './useAgentCapabilities';

const log = createLogger('useAvailableAgents');

let localCapabilitiesRefreshInFlight: Promise<void> | null = null;
const remoteCapabilitiesRefreshInFlight = new Map<string, Promise<void>>();

function refreshLocalCapabilitiesOnce(): void {
  if (localCapabilitiesRefreshInFlight) return;
  const pending = refreshLocalCapabilities().finally(() => {
    if (localCapabilitiesRefreshInFlight === pending) localCapabilitiesRefreshInFlight = null;
  });
  localCapabilitiesRefreshInFlight = pending;
}

function refreshRemoteCapabilitiesOnce(deviceId: string): void {
  if (remoteCapabilitiesRefreshInFlight.has(deviceId)) return;
  evictDeviceCapabilities(deviceId);
  const pending = prefetchDeviceCapabilities(deviceId).finally(() => {
    if (remoteCapabilitiesRefreshInFlight.get(deviceId) === pending) {
      remoteCapabilitiesRefreshInFlight.delete(deviceId);
    }
  });
  remoteCapabilitiesRefreshInFlight.set(deviceId, pending);
}

type RuntimeAgentKind = 'claude-code' | 'codex' | 'pi';

/** runtime agent id → NewMaker vendor(其余保持同名)。 */
function toVendor(agent: RuntimeAgentKind): MakerVendor {
  return agent === 'claude-code' ? 'cc' : agent;
}

interface MakerApiShape {
  listAvailableAgents: () => Promise<RuntimeAgentKind[]>;
  onAgentsChanged: (cb: () => void) => () => void;
}
interface DeviceLinkShape {
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
  onPresenceChanged?: (cb: (snapshot: { deviceId: string; online: boolean }) => void) => () => void;
  onStatusChanged?: (cb: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => () => void;
  onRemotePush?: (
    cb: (payload: { deviceId: string; channel: string; payload: unknown }) => void,
  ) => () => void;
}

function getMakerApi(): MakerApiShape | null {
  return (window as unknown as { electronAPI?: { maker?: MakerApiShape } }).electronAPI?.maker ?? null;
}
function getDeviceLink(): DeviceLinkShape | null {
  return (window as unknown as { electronAPI?: { deviceLink?: DeviceLinkShape } }).electronAPI?.deviceLink ?? null;
}

async function fetchAvailableAgents(deviceId?: string | null): Promise<RuntimeAgentKind[]> {
  if (deviceId) {
    const dl = getDeviceLink();
    if (!dl) throw new Error('device-link IPC not available');
    const raw = await dl.invoke(deviceId, 'maker:list-available-agents', []);
    return Array.isArray(raw) ? (raw.filter((v): v is RuntimeAgentKind =>
      v === 'claude-code' || v === 'codex' || v === 'pi') as RuntimeAgentKind[]) : [];
  }
  const api = getMakerApi();
  if (!api) throw new Error('maker IPC not available');
  return api.listAvailableAgents();
}

/**
 * 模块级结果缓存 —— 按 deviceId 分 key(本机用 `''`)。
 *
 * 为什么需要:本 hook 每个消费方实例各挂一份 effect + focus 监听。composer / 首页草稿 /
 * 设置页可能同时在场,窗口一聚焦就并发打同一条 IPC(远程还要过隧道)。三件事一起做:
 *   - **缓存**:已有结果的实例挂载即出值,不再从空集合闪一帧(空集合会被消费方读成
 *     「先别隐藏任何入口」,但 loaded 的翻转仍会带来一次多余重渲染);
 *   - **并发去重**:同 key 的在途请求共用一个 promise;
 *   - **focus 节流**:上次成功不足 REFETCH_MIN_INTERVAL_MS 就不重拉(Pi 二进制补齐是
 *     分钟级的事,秒级重拉没有意义)。
 * 缓存只在进程内,失败不写缓存(保持 fail-open 的下一次重试机会)。
 */
const REFETCH_MIN_INTERVAL_MS = 15_000;
interface AgentsCacheEntry {
  vendors: ReadonlySet<MakerVendor>;
  fetchedAt: number;
}
const agentsCache = new Map<string, AgentsCacheEntry>();
const inFlight = new Map<string, Promise<ReadonlySet<MakerVendor>>>();
/**
 * 每个 roster 缓存 key 的失效代际。收到 roster push 后递增，使 push 之前发起的
 * 在途请求不能把旧的 agent 集合重新写回缓存或覆盖当前 hook 状态。
 */
const agentsCacheGeneration = new Map<string, number>();
/** 同一 roster push 会同步通知多个 mounted consumer；同一 tick 只失效一次。 */
const agentsCacheInvalidationScheduled = new Set<string>();
const rosterListeners = new Map<string, Set<() => void>>();
let localRosterSourceInstalled = false;
let remoteRosterSourceInstalled = false;
let relayStatus: 'stopped' | 'connecting' | 'online' | null = null;
const deviceOnline = new Map<string, boolean>();

function currentAgentsCacheGeneration(key: string): number {
  return agentsCacheGeneration.get(key) ?? 0;
}

function invalidateAgentsCache(key: string): boolean {
  if (agentsCacheInvalidationScheduled.has(key)) return false;
  agentsCacheInvalidationScheduled.add(key);
  queueMicrotask(() => agentsCacheInvalidationScheduled.delete(key));
  const generation = currentAgentsCacheGeneration(key) + 1;
  agentsCacheGeneration.set(key, generation);
  agentsCache.delete(key);
  inFlight.delete(key);
  return true;
}

function remoteRosterKeys(): Set<string> {
  const keys = new Set([
    ...agentsCache.keys(),
    ...inFlight.keys(),
    ...rosterListeners.keys(),
  ]);
  keys.delete('');
  return keys;
}

function notifyRosterChanged(deviceId?: string): void {
  // Presence includes controller-only phones. Only refresh devices whose roster
  // was actually requested; reverse capability invokes to an iPhone are rejected
  // and can tear down the peer link currently serving that phone's requests.
  if (deviceId && !remoteRosterKeys().has(deviceId)) return;
  const key = cacheKeyOf(deviceId);
  if (!invalidateAgentsCache(key)) return;
  if (deviceId) refreshRemoteCapabilitiesOnce(deviceId);
  else refreshLocalCapabilitiesOnce();
  for (const listener of rosterListeners.get(key) ?? []) listener();
}

function ensureRosterSource(key: string): void {
  if (key === '') {
    if (localRosterSourceInstalled) return;
    const api = getMakerApi();
    if (!api?.onAgentsChanged) return;
    localRosterSourceInstalled = true;
    api.onAgentsChanged(() => notifyRosterChanged());
    return;
  }
  if (remoteRosterSourceInstalled) return;
  const dl = getDeviceLink();
  if (!dl) return;
  remoteRosterSourceInstalled = true;
  dl.onRemotePush?.((push) => {
    if (push.channel === 'maker:agents:changed') notifyRosterChanged(push.deviceId);
  });
  dl.onPresenceChanged?.((snapshot) => {
    const wasOnline = deviceOnline.get(snapshot.deviceId);
    deviceOnline.set(snapshot.deviceId, snapshot.online);
    if (snapshot.online && wasOnline !== true) notifyRosterChanged(snapshot.deviceId);
  });
  dl.onStatusChanged?.(({ status }) => {
    const wasOnline = relayStatus;
    relayStatus = status;
    if (status === 'online' && wasOnline !== 'online') {
      for (const deviceId of remoteRosterKeys()) notifyRosterChanged(deviceId);
    }
  });
}

function subscribeRosterChanges(key: string, listener: () => void): () => void {
  const bucket = rosterListeners.get(key) ?? new Set<() => void>();
  bucket.add(listener);
  rosterListeners.set(key, bucket);
  ensureRosterSource(key);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) rosterListeners.delete(key);
  };
}

function cacheKeyOf(deviceId?: string | null): string {
  return deviceId ?? '';
}

function loadAvailableAgents(deviceId?: string | null): Promise<ReadonlySet<MakerVendor>> {
  const key = cacheKeyOf(deviceId);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const requestGeneration = currentAgentsCacheGeneration(key);
  const promise = fetchAvailableAgents(deviceId)
    .then((agents) => {
      const vendors: ReadonlySet<MakerVendor> = new Set(agents.map(toVendor));
      // A roster push can invalidate this request while the IPC call is pending. Do not
      // let that pre-change response become the authoritative cache entry.
      if (currentAgentsCacheGeneration(key) === requestGeneration) {
        agentsCache.set(key, { vendors, fetchedAt: Date.now() });
      }
      return vendors;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

export interface UseAvailableAgentsResult {
  /** runtime 已注册的 vendor 集合(cc/codex/pi);loaded=false 时为空。 */
  availableVendors: ReadonlySet<MakerVendor>;
  /** 首次结果是否已返回。未加载完成时消费方不应据此隐藏任何入口。 */
  loaded: boolean;
}

/**
 * @param deviceId 省略/undefined = 本机;传值 = 该被控端(device-link)。
 */
export function useAvailableAgents(deviceId?: string | null): UseAvailableAgentsResult {
  const cached = agentsCache.get(cacheKeyOf(deviceId));
  // 初值取缓存:同一 deviceId 已经查过时,新实例挂载即出值,不再走一遍「空集合 → loaded」
  // 的闪帧。useState 的 lazy 初值只在首次 render 取一次,后续由下面的 effect 维护。
  const [availableVendors, setAvailableVendors] = useState<ReadonlySet<MakerVendor>>(
    () => cached?.vendors ?? new Set(),
  );
  const [loaded, setLoaded] = useState(() => cached !== undefined);

  useEffect(() => {
    let cancelled = false;
    const hit = agentsCache.get(cacheKeyOf(deviceId));
    setAvailableVendors(hit?.vendors ?? new Set());
    setLoaded(hit !== undefined);
    const key = cacheKeyOf(deviceId);
    const run = (): void => {
      const requestGeneration = currentAgentsCacheGeneration(key);
      loadAvailableAgents(deviceId)
        .then((vendors) => {
          if (cancelled || currentAgentsCacheGeneration(key) !== requestGeneration) return;
          setAvailableVendors(vendors);
          setLoaded(true);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // fail-open:查询失败时不隐藏任何入口(loaded 保持原值)——宁可多显示一个
          // 也不因一次 IPC 抖动把合法 agent 从创建入口里抹掉。真正的兜底是创建期 requireAgent。
          log.warn('listAvailableAgents failed; not gating agent entries this cycle', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    };
    run();
    const offRosterChanged = subscribeRosterChanges(key, run);
    // 会话期间 Pi 二进制可能被按需下载补齐:窗口重新聚焦时再拉一次,让入口及时出现。
    // 节流:补齐是分钟级的事,秒级来回切窗口不必反复打 IPC(远程还要过隧道)。
    const onFocus = (): void => {
      const fresh = agentsCache.get(cacheKeyOf(deviceId));
      if (fresh && Date.now() - fresh.fetchedAt < REFETCH_MIN_INTERVAL_MS) return;
      run();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      offRosterChanged();
    };
  }, [deviceId]);

  return { availableVendors, loaded };
}

/** 测试用 —— 清进程内缓存与在途请求(其它代码不应调用)。 */
export function __resetAvailableAgentsCacheForTest(): void {
  for (const key of new Set([
    ...agentsCache.keys(),
    ...inFlight.keys(),
    ...agentsCacheGeneration.keys(),
  ])) {
    invalidateAgentsCache(key);
  }
  agentsCache.clear();
  inFlight.clear();
  agentsCacheInvalidationScheduled.clear();
}
