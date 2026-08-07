/**
 * useAgentCapabilities — 按需拉取 maker-core 暴露的 agent capabilities。
 *
 * 设计：
 * - 每个 agentKind 一份缓存 (module-scoped Map), 同 kind 第二次调用直接命中
 * - 拉取过程暴露 loading/error 给调用方决定 fallback
 * - 大部分 capability 静态；目录模型在 Codex 鉴权 / discovery 变化后原子刷新本地缓存
 *
 * 用法:
 *   const { capabilities } = useAgentCapabilities('claude-code');
 *   capabilities?.availableModels.map(...);
 */
import { useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';

const log = createLogger('useAgentCapabilities');

export type AgentKind = 'claude-code' | 'codex' | 'pi';

// capability 生命周期(预取 / 驱逐通知 / 本地快照刷新 / 启动预载)必须覆盖全部 agent，
// 少一个就会让该 agent 的远程会话在断链或 provider revision 后收不到 loading 事件、
// 也不再被重新预取，界面永久停在旧模型/能力快照(codex review)。新增 agent 只改这里。
const ALL_AGENT_KINDS = ['claude-code', 'codex', 'pi'] as const;

// renderer 视角: id 全部是不透明 string, 渲染只读 displayName。
// effort 的合法 id 集合 = capabilities.effortLevels 上每个项的 id。
export interface ModelDescriptor {
  id: string;
  displayName: string;
  /** 目录分组 id(如 'gpt-budget'): 折扣版与官方版 displayName 同名, 靠它区分。 */
  group?: string;
  /**
   * Gateway 原生 mode(issue #882)。availableModels 派生时已经过 isChatEligible
   * 过滤,这里透传只是让下游按 model 二次分类的逻辑(如 resolveSourceSwitch 的
   * classifyModel)拿到 mode,不必回读目录(2026-07 review)。
   */
  mode?: string;
  description?: string;
  contextWindow: number;
  efforts: readonly Effort[];
  effortDisplayNames?: Partial<Record<Effort, string>>;
  defaultEffort: Effort | null;
  supportsFastMode?: boolean;
  /** 目录展示排序权重;缺省排末尾。 */
  sortOrder?: number;
  /**
   * 选择器里默认是否可见(源自目录 defaultEnabled,缺省 ⇒ 可见)。
   * 消费点见 modelDefinitions.getDefaultModelForVendor:种子默认只从默认可见的模型里取。
   */
  defaultEnabled?: boolean;
  /**
   * 该模型是哪些 wire agent 的**新对话默认种子**(源自目录 newSessionDefault,与 sortOrder
   * 解耦;生产环境 XD 网关由服务端按区域下发)。消费点见 modelDefinitions.newSessionDefaultModelId
   * 与 draftModelCalibration:被标记且可用的模型优先作新对话默认。pi 按 'claude-code' 口径判定。
   */
  newSessionDefault?: ('claude-code' | 'codex')[];
}

export interface EffortDescriptor {
  id: Effort;
  displayName: string;
  description?: string;
}

export interface PermissionModeDescriptor {
  id: PermissionMode;
  displayName: string;
  description?: string;
}

/**
 * CapabilityStatus 与 maker-core Capabilities['fork'/'rewind'] 同形,
 * 让 UI 直接判 supported 决定 icon 显示。
 */
export type CapabilityStatus =
  | { supported: true }
  | {
      supported: false;
      reason?: 'sdk-missing' | 'not-implemented' | 'platform-limited';
      upstreamRef?: string;
      message?: string;
    };

export interface AgentCapabilities {
  availableModels: ModelDescriptor[];
  /** Agent 是否实现 Fast Mode 运行时能力。 */
  hasFastMode: boolean;
  effortLevels: EffortDescriptor[];
  permissionModes: PermissionModeDescriptor[];
  /**
   * 计划模式一级开关(composer「+」菜单入口)据此显示 / 隐藏。
   * device-link 老被控端序列化的 capabilities 无此字段 → undefined = 不支持。
   */
  planMode?: CapabilityStatus;
  /** Session fork — UserMessage 下方 Fork icon 据此显示 / 隐藏。 */
  fork?: CapabilityStatus;
  /** Session rewind — UserMessage 下方 Rewind icon 据此显示 / 隐藏。 */
  rewind?: CapabilityStatus;
  /**
   * 同会话跨引擎切换(Claude Code ↔ Codex)。host 级能力,两个 agent 的 capabilities
   * 都带回同一个值;device-link 老被控端无此字段 → undefined = 不支持,控制端隐藏
   * 模型选择器顶部的 Agent 分段(它同时也没收录切换 channel,点了必失败)。
   */
  supportsSessionAgentSwitch?: boolean;
  /**
   * 同引擎重选是否返回可供 SET_MODEL 二次校验的 CAS 修订号。首版切换 host 只有上面的
   * 基础能力位；远程控制端必须同时看到本位才开放入口，避免旧 host 的清除回流先于 ack
   * 到达时无法安全关联后续模型写入。
   */
  supportsSessionAgentSwitchCas?: boolean;
  /**
   * 被控端是否支持在开启 Orca Team 时显式设置 Worker 默认权限。
   * device-link 老被控端无此字段 → undefined，控制端必须阻止开启协同并提示升级。
   */
  supportsOrcaWorkerPermissionMode?: boolean;
  /**
   * 每轮 host 权限策略能力门:未声明或 supported.supported !== true 的 Agent 无法
   * 用于「无条件挂逐条权限确认」的渠道(如个人微信)。与 maker-core 的
   * Capabilities.turnPermissionPolicy 同构;device-link 老被控端无此字段 →
   * undefined = 不支持。
   */
  turnPermissionPolicy?: {
    supported: CapabilityStatus;
    unsupportedPermissionModes: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalStringRecord(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((label) => typeof label === 'string'))
  );
}

/** 与 protocol newSessionDefault 约束一致:可选;存在时非空、wire agent、无重复。 */
function isOptionalNewSessionDefault(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  if (
    value.some(
      (agent) => agent !== 'claude-code' && agent !== 'codex',
    )
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function isModelDescriptor(value: unknown): value is ModelDescriptor {
  if (!isRecord(value)) return false;
  const efforts = value.efforts;
  const defaultEffort = value.defaultEffort;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.displayName === 'string' &&
    value.displayName.length > 0 &&
    typeof value.contextWindow === 'number' &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow > 0 &&
    isStringArray(efforts) &&
    (defaultEffort === null ||
      (typeof defaultEffort === 'string' && efforts.includes(defaultEffort))) &&
    isOptionalString(value.group) &&
    isOptionalString(value.mode) &&
    isOptionalString(value.description) &&
    isOptionalStringRecord(value.effortDisplayNames) &&
    isOptionalBoolean(value.supportsFastMode) &&
    isOptionalFiniteNumber(value.sortOrder) &&
    isOptionalBoolean(value.defaultEnabled) &&
    isOptionalNewSessionDefault(value.newSessionDefault)
  );
}

function isNamedDescriptor(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.displayName === 'string' &&
    value.displayName.length > 0 &&
    isOptionalString(value.description)
  );
}

function parseAgentCapabilities(value: unknown): AgentCapabilities {
  if (!isRecord(value)) {
    throw new Error('Invalid agent capabilities response');
  }
  if (
    !Array.isArray(value.availableModels) ||
    !value.availableModels.every(isModelDescriptor) ||
    typeof value.hasFastMode !== 'boolean' ||
    !Array.isArray(value.effortLevels) ||
    !value.effortLevels.every(isNamedDescriptor) ||
    !Array.isArray(value.permissionModes) ||
    !value.permissionModes.every(isNamedDescriptor) ||
    !isOptionalBoolean(value.supportsSessionAgentSwitch) ||
    !isOptionalBoolean(value.supportsSessionAgentSwitchCas) ||
    !isOptionalBoolean(value.supportsOrcaWorkerPermissionMode)
  ) {
    throw new Error('Invalid agent capabilities response');
  }
  return value as unknown as AgentCapabilities;
}

interface MakerApiShape {
  getCapabilities: (agentKind: AgentKind) => Promise<AgentCapabilities>;
}

interface DeviceLinkShape {
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}

function getMakerApi(): MakerApiShape | null {
  const api = (
    window as unknown as {
      electronAPI?: { maker?: MakerApiShape };
    }
  ).electronAPI?.maker;
  return api ?? null;
}

function getDeviceLink(): DeviceLinkShape | null {
  const dl = (
    window as unknown as {
      electronAPI?: { deviceLink?: DeviceLinkShape };
    }
  ).electronAPI?.deviceLink;
  return dl ?? null;
}

// device-link「以被控端为准」:远程会话的能力必须来自被控端,不能用控制端本地 maker。
// 缓存按 (deviceId, agentKind) 隔离 —— 两台机器模型/能力配置可能不同,绝不能串。
// deviceId 省略 = 本机会话,走与改造前逐字节相同的本地路径(零回归)。
type CacheKey = string;
function cacheKey(agentKind: AgentKind, deviceId?: string): CacheKey {
  return `${deviceId ?? 'local'}:${agentKind}`;
}

const cache = new Map<CacheKey, AgentCapabilities>();
const inflight = new Map<CacheKey, Promise<AgentCapabilities>>();
/** 本地能力刷新代际；使刷新前的在途 IPC 结果无法回写旧快照。 */
let localGen = 0;
/** 已挂载 hook 的本地能力订阅者；刷新完成后一次性切到新快照，避免中途空白帧。 */
const localListeners = new Set<(agent: AgentKind, caps: AgentCapabilities) => void>();
/** 远程能力缓存事件；驱逐时先标 stale，成功 / 失败后再结束这一轮刷新。 */
export type DeviceCapabilitiesEvent =
  | { status: 'loading' }
  | { status: 'ready'; capabilities: AgentCapabilities }
  | { status: 'error'; error: string };
/** 已挂载的远程能力订阅者；key 同缓存，provider revision 后可原子换入新快照。 */
const remoteListeners = new Map<CacheKey, Set<(event: DeviceCapabilitiesEvent) => void>>();
/**
 * 每被控设备的能力「代际」。`evictDeviceCapabilities` 时自增——在途的 fetchCapabilities 完成
 * 回调据此判断「本次请求是否已被驱逐」:被驱逐则**丢弃结果**,既不回写 cache、也不动 inflight
 * (evict 已清,且可能已有新一轮 fetch 占了 inflight,误删会破坏新请求)。否则设备下线 / 断链后
 * 在途 prefetch 的 .then 会把陈旧 model/effort 重新灌回缓存(重连 / 升级目标端后串旧能力)。
 * 本机用 localGen 处理目录热刷新；远端继续按 deviceGen 隔离。
 */
const deviceGen = new Map<string, number>();

function notifyRemoteCapabilities(
  deviceId: string,
  agentKind: AgentKind,
  event: DeviceCapabilitiesEvent,
): void {
  for (const listener of remoteListeners.get(cacheKey(agentKind, deviceId)) ?? []) listener(event);
}

/** 订阅某被控端某 agent 的能力快照；只通知当前代际成功提交的完整结果。 */
export function subscribeDeviceCapabilities(
  deviceId: string,
  agentKind: AgentKind,
  listener: (event: DeviceCapabilitiesEvent) => void,
): () => void {
  const key = cacheKey(agentKind, deviceId);
  const bucket = remoteListeners.get(key) ?? new Set<(event: DeviceCapabilitiesEvent) => void>();
  bucket.add(listener);
  remoteListeners.set(key, bucket);
  return () => {
    bucket.delete(listener);
    if (bucket.size === 0) remoteListeners.delete(key);
  };
}

async function fetchCapabilities(
  agentKind: AgentKind,
  deviceId?: string,
): Promise<AgentCapabilities> {
  const key = cacheKey(agentKind, deviceId);
  const cached = cache.get(key);
  if (cached) return cached;
  const ip = inflight.get(key);
  if (ip) return ip;

  // 捕获发起时的设备代际;回调里若代际已变(被 evict)则认为本次请求作废。
  const startGen = deviceId ? (deviceGen.get(deviceId) ?? 0) : localGen;
  const isCurrent = (): boolean =>
    deviceId ? (deviceGen.get(deviceId) ?? 0) === startGen : localGen === startGen;

  let raw: Promise<AgentCapabilities>;
  if (deviceId) {
    // 远程:隧道到被控端的 maker:get-capabilities(已在 allowlist)。
    const dl = getDeviceLink();
    if (!dl) throw new Error('device-link IPC not available');
    raw = dl.invoke(deviceId, 'maker:get-capabilities', [agentKind]) as Promise<AgentCapabilities>;
  } else {
    // 本机:原路径,行为不变。
    const api = getMakerApi();
    if (!api) throw new Error('maker IPC not available');
    raw = api.getCapabilities(agentKind);
  }
  const p = raw
    .then((value) => {
      const caps = parseAgentCapabilities(value);
      // 在途期间设备被驱逐(下线 / 断链)→ 丢弃结果,不回写 cache、不动 inflight。
      if (isCurrent()) {
        cache.set(key, caps);
        inflight.delete(key);
        if (deviceId)
          notifyRemoteCapabilities(deviceId, agentKind, { status: 'ready', capabilities: caps });
      } else if (!deviceId) {
        // 本地热刷新可能已原子换入更新快照；旧请求的调用方也应拿当前 cache，不能在
        // listener 更新之后又把 hook state 覆盖回旧对象。刷新仍在途时保留旧对象，完成后再通知。
        return cache.get(key) ?? caps;
      }
      return caps;
    })
    .catch((e) => {
      if (isCurrent()) {
        inflight.delete(key);
        if (deviceId) {
          notifyRemoteCapabilities(deviceId, agentKind, {
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      throw e;
    });
  inflight.set(key, p);
  return p;
}

export interface UseAgentCapabilitiesResult {
  capabilities: AgentCapabilities | null;
  loading: boolean;
  error: string | null;
}

export function useAgentCapabilities(
  agentKind: AgentKind | null | undefined,
  deviceId?: string,
): UseAgentCapabilitiesResult {
  const selectedKey = agentKind ? cacheKey(agentKind, deviceId) : null;
  const initialCapabilities = selectedKey ? cache.get(selectedKey) : undefined;
  const [ownerKey, setOwnerKey] = useState<CacheKey | null>(
    initialCapabilities ? selectedKey : null,
  );
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(
    initialCapabilities ?? null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentKind) return undefined;
    const key = cacheKey(agentKind, deviceId);
    const applyRemoteEvent = (event: DeviceCapabilitiesEvent): void => {
      if (event.status === 'loading') {
        // 保留上一份完整快照以避免空白帧，但显式标记为 stale，调用方不得据此改写选择。
        setOwnerKey(key);
        setLoading(true);
        setError(null);
        return;
      }
      if (event.status === 'error') {
        setOwnerKey(key);
        setCapabilities(null);
        setLoading(false);
        setError(event.error);
        return;
      }
      setOwnerKey(key);
      setCapabilities(event.capabilities);
      setLoading(false);
      setError(null);
    };
    if (deviceId) return subscribeDeviceCapabilities(deviceId, agentKind, applyRemoteEvent);
    const applySnapshot = (caps: AgentCapabilities): void => {
      setOwnerKey(key);
      setCapabilities(caps);
      setLoading(false);
      setError(null);
    };
    const onRefresh = (refreshedAgent: AgentKind, caps: AgentCapabilities): void => {
      if (refreshedAgent !== agentKind) return;
      applySnapshot(caps);
    };
    localListeners.add(onRefresh);
    return () => {
      localListeners.delete(onRefresh);
    };
  }, [agentKind, deviceId]);

  useEffect(() => {
    if (!agentKind) {
      setOwnerKey(null);
      setCapabilities(null);
      setLoading(false);
      setError(null);
      return;
    }
    const key = cacheKey(agentKind, deviceId);
    const cached = cache.get(key);
    if (cached) {
      setOwnerKey(key);
      setCapabilities(cached);
      // 缓存命中 = 数据已就绪,必须把上一目标遗留的 loading / error 一并清掉。
      // 漏了会卡死:从「能力还在加载」的设备切到已缓存的设备时走到这里直接 return,
      // 后续既没有请求也没有 listener 事件来收尾,loading 就永久停在 true,而创建页的
      // send / goal guard 正是看 capabilitiesLoading —— 于是在路由重挂载前一直拒绝创建。
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    // cache miss:先清掉上一设备 / 会话的能力,避免 fetch 解析前(失败则永远)UI 残留旧设备的
    // 模型 / effort 列表 → 远程会话误选目标端不支持的模型。
    setOwnerKey(key);
    setCapabilities(null);
    setLoading(true);
    setError(null);
    const remoteGeneration = deviceId ? (deviceGen.get(deviceId) ?? 0) : null;
    fetchCapabilities(agentKind, deviceId)
      .then((caps) => {
        // 远程成功结果只经「当前代际 cache commit → listener」更新，避免 revision 前的
        // 旧 Promise 晚到后直接把已刷新的 hook state 覆盖回旧快照。
        if (cancelled || deviceId) return;
        setCapabilities(caps);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (deviceId && (deviceGen.get(deviceId) ?? 0) !== remoteGeneration) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        if (deviceId && (deviceGen.get(deviceId) ?? 0) !== remoteGeneration) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentKind, deviceId]);

  const ownsSelection = ownerKey === selectedKey;
  return {
    capabilities: ownsSelection ? capabilities : null,
    loading: selectedKey !== null && (!ownsSelection || loading),
    error: ownsSelection ? error : null,
  };
}

/**
 * 同步读取已缓存的 capabilities (没缓存返回 null)。
 * 用于 useMemo / 同步逻辑里需要 capabilities 但又不能起 effect 的场景。
 * deviceId 省略 = 本机缓存(行为不变);传 deviceId = 该被控端的缓存。
 */
export function getCachedCapabilities(
  agentKind: AgentKind,
  deviceId?: string,
): AgentCapabilities | null {
  return cache.get(cacheKey(agentKind, deviceId)) ?? null;
}

/**
 * device-link:订阅某被控设备时预取其两个 agent 的能力,使首次打开远程会话时
 * 模型下拉 / fast / effort 不为空、modelDefinitions 同步层已热。失败 swallow(轮询/打开会话会再取)。
 */
export async function prefetchDeviceCapabilities(deviceId: string): Promise<void> {
  await Promise.allSettled(ALL_AGENT_KINDS.map((agent) => fetchCapabilities(agent, deviceId)));
}

/** device-link:被控设备下线 / 断链时驱逐其能力缓存(只清该设备的 key)。 */
export function evictDeviceCapabilities(deviceId: string): void {
  const prefix = `${deviceId}:`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
  // 代际自增:作废该设备所有在途 fetch 的回写(防其 .then 把陈旧能力复活回 cache)。
  deviceGen.set(deviceId, (deviceGen.get(deviceId) ?? 0) + 1);
  // 已挂载 hook 必须同步知道旧快照已失效；否则 provider 新快照先到时会拿旧 capabilities
  // 计算 fallback，并永久覆盖用户原本保存的模型偏好。
  for (const agentKind of ALL_AGENT_KINDS) {
    notifyRemoteCapabilities(deviceId, agentKind, { status: 'loading' });
  }
}

export type LocalCapabilitiesSnapshot = ReadonlyArray<readonly [AgentKind, AgentCapabilities]>;

/** 开始一轮本地 capabilities 刷新，并作废所有更早的本地请求。 */
export function beginLocalCapabilitiesRefresh(): number {
  localGen += 1;
  for (const agent of ALL_AGENT_KINDS) {
    inflight.delete(cacheKey(agent));
  }
  return localGen;
}

/**
 * 读取本地 agent 能力快照；核心 agent 失败向上抛，可选 Pi 的能力读取失败不阻断 provider 目录。
 */
export async function loadLocalCapabilitiesSnapshot(): Promise<LocalCapabilitiesSnapshot> {
  const api = getMakerApi();
  if (!api) throw new Error('maker IPC not available');
  const entries = await Promise.all(
    ALL_AGENT_KINDS.map(async (agent): Promise<readonly [AgentKind, AgentCapabilities] | null> => {
      try {
        return [agent, await api.getCapabilities(agent)] as const;
      } catch (error) {
        if (agent !== 'pi') throw error;
        log.warn('optional Pi capabilities unavailable; continuing with core agents:', error);
        return null;
      }
    }),
  );
  return entries.filter(
    (entry): entry is readonly [AgentKind, AgentCapabilities] => entry !== null,
  );
}

export function isLocalCapabilitiesRefreshCurrent(generation: number): boolean {
  return localGen === generation;
}

/** 仅提交当前代际的可用能力快照，并在提交后统一通知 mounted hooks。 */
export function commitLocalCapabilitiesSnapshot(
  generation: number,
  entries: LocalCapabilitiesSnapshot,
): boolean {
  if (!isLocalCapabilitiesRefreshCurrent(generation)) return false;
  for (const [agent, caps] of entries) cache.set(cacheKey(agent), caps);
  for (const [agent, caps] of entries) {
    for (const listener of localListeners) listener(agent, caps);
  }
  return true;
}

/**
 * Codex auth/discovery 广播后的本地热刷新。旧 cache 在核心 IPC 都成功前继续可读；完成后
 * 同时替换 cache 并通知 mounted hooks，避免 provider:list 已更新而 scheduler/selector 仍用旧能力。
 */
export async function refreshLocalCapabilities(): Promise<void> {
  const generation = beginLocalCapabilitiesRefresh();
  try {
    commitLocalCapabilitiesSnapshot(generation, await loadLocalCapabilitiesSnapshot());
  } catch (err) {
    if (isLocalCapabilitiesRefreshCurrent(generation)) {
      log.warn('refreshLocalCapabilities failed:', err);
    }
  }
}

/**
 * 在 app 启动 (preload IPC 就绪后) 调一次, 把两边 agent 的 capabilities 都预拉到 cache。
 * 让 modelDefinitions.ts 这种 sync 兼容层立刻有数据。
 */
export async function preloadAllCapabilities(): Promise<void> {
  const load = () => Promise.all(ALL_AGENT_KINDS.map((agent) => fetchCapabilities(agent)));

  // 防御性重试：EnvCheckGuard 已保证 handler 已注册，这里兜底瞬时 IPC 故障
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await load();
      return;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        log.warn('preloadAllCapabilities failed after 3 attempts:', err);
      }
    }
  }
}
