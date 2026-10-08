/**
 * agentDeviceModelMemory —— 远程 Agent(Agent 在同账号另一台电脑上运行)的模型档位记忆:
 * 按「电脑 + Agent + 供应商 + 模型」记 effort / Fast / thinking,localStorage 持久化,跨任务、
 * 跨重启在本机生效。
 *
 * 为什么单独一份(而非复用 providerModelMemory):
 *   远程 Agent 用的是那台电脑的供应商目录,来源 id 与本机的不是一回事(同叫 anthropic,可能是
 *   两个不同账号)。写进本机 providerModelMemory 会让本机任务带上那台的档位;而且本机那份
 *   会经 snapshotForSeed 同步给 main 与远程控制端,混进来会被当成本机的模型预设。
 *   也不写回那台电脑自己的记忆:远程调用只借用它的供应商,不改它本地的设置。
 *
 * 表里只存用户改过的值(override):没有该键 ⇒ 跟随那台电脑目录的当前默认;「恢复推荐」= 删键。
 *
 * 按 dataOwnerId 分区持久化(setAgentDeviceModelMemoryOwner),与 providerModelMemory 同一处切换,
 * 避免多账号互相继承档位。写入频率极低(只在用户改档 / 选模型时),同步写 localStorage,不做
 * batch / debounce —— 与 providerModelMemory 的取舍一致(热更新 relaunch 强退不丢最近一次改动)。
 */

import { useSyncExternalStore } from 'react';

import type { ModelMemoryAccessors } from '@/components/new-chat/ModelSelector';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

const STORAGE_KEY = 'xdt:agentDeviceModelMemory:v1';

/** 某台电脑某 (agent, 来源) 下每个模型的 override。 */
interface Slot {
  effortByModel: Record<string, Effort>;
  fastByModel: Record<string, boolean>;
  thinkingByModel: Record<string, boolean>;
}

/** deviceId → (`${agent}:${providerId}` → Slot)。 */
type MemoryMap = Record<string, Record<string, Slot>>;

/** 与 providerModelMemory snapshot 同形,供 resolveDeviceLinkDraftDefaults 按目标模型还原档位。 */
export type AgentDeviceModelMemorySnapshot = Record<
  string,
  {
    effortByModel: Record<string, string>;
    fastByModel: Record<string, boolean>;
    thinkingByModel: Record<string, boolean>;
  }
>;

type SlotField = keyof Slot;

let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId
    ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}`
    : STORAGE_KEY;
}

function slotKey(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

function sanitizeRecord<T extends string | boolean>(
  raw: unknown,
  valid: (value: unknown) => value is T,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (model && valid(value)) out[model] = value;
  }
  return out;
}

const isEffort = (value: unknown): value is Effort =>
  typeof value === 'string' && value.length > 0;
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';

function isEmptySlot(slot: Slot): boolean {
  return (
    Object.keys(slot.effortByModel).length === 0 &&
    Object.keys(slot.fastByModel).length === 0 &&
    Object.keys(slot.thinkingByModel).length === 0
  );
}

/** 损坏 / 手改的 localStorage 静默收敛,空槽、空设备一并丢弃。 */
function sanitize(raw: unknown): MemoryMap {
  const out: MemoryMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [deviceId, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!deviceId || !slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const bySlot: Record<string, Slot> = {};
    for (const [key, value] of Object.entries(slots as Record<string, unknown>)) {
      if (!key || !value || typeof value !== 'object') continue;
      const rec = value as Partial<Record<SlotField, unknown>>;
      const slot: Slot = {
        effortByModel: sanitizeRecord(rec.effortByModel, isEffort),
        fastByModel: sanitizeRecord(rec.fastByModel, isBoolean),
        thinkingByModel: sanitizeRecord(rec.thinkingByModel, isBoolean),
      };
      if (!isEmptySlot(slot)) bySlot[key] = slot;
    }
    if (Object.keys(bySlot).length > 0) out[deviceId] = bySlot;
  }
  return out;
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: MemoryMap | null = null;

function loadFromStorage(): MemoryMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey());
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function load(): MemoryMap {
  if (!cache) cache = loadFromStorage();
  return cache;
}

/**
 * 写前重读当前 owner 分区,避免另一个 renderer 刚写入的值被本窗口旧缓存整表覆盖。
 * localStorage 不可读时保留本窗口内存态,不能用空表抹掉尚未成功持久化的用户选择。
 */
function freshMap(): MemoryMap {
  if (typeof window === 'undefined') return load();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey());
  } catch {
    return load();
  }
  if (raw === null) return load();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return load();
  }
}

const listeners = new Set<() => void>();
let version = 0;
function emit(): void {
  version++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getVersion(): number {
  return version;
}

/** React hook —— 订阅变更版本号(模型面板据此重算各行的档位 / Fast 显示)。 */
export function useAgentDeviceModelMemoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function persist(next: MemoryMap): void {
  cache = next;
  emit();
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // 写不进去时保留本窗口内存态,本次运行内仍然记得;下一次写入会再整表尝试落盘。
  }
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== storageKey()) return;
    // storage 事件可能迟到,event.newValue 不是当前真相;始终重读当前 owner 分区。
    cache = loadFromStorage();
    emit();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    removeStorageListener?.();
  });
}

function readSlot(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): Slot | undefined {
  if (!deviceId || !providerId || !model) return undefined;
  return load()[deviceId]?.[slotKey(agent, providerId)];
}

/** 写一个模型键;value 为 undefined = 删键(跟随默认)。同值 / 本就没有时短路,不落盘。 */
function writeValue<F extends SlotField>(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  field: F,
  value: Slot[F][string] | undefined,
): void {
  if (!deviceId || !providerId || !model) return;
  const map = freshMap();
  const key = slotKey(agent, providerId);
  const device = map[deviceId] ?? {};
  const slot = device[key] ?? { effortByModel: {}, fastByModel: {}, thinkingByModel: {} };
  // 磁盘已是目标值:不落盘。本窗口缓存若还是旧的,别窗那笔写入的 storage 事件会刷新它。
  if (slot[field][model] === value) return;
  const nextField = { ...slot[field] } as Record<string, Slot[F][string]>;
  if (value === undefined) delete nextField[model];
  else nextField[model] = value;
  const nextSlot = { ...slot, [field]: nextField } as Slot;
  const nextDevice = { ...device };
  if (isEmptySlot(nextSlot)) delete nextDevice[key];
  else nextDevice[key] = nextSlot;
  const next = { ...map };
  if (Object.keys(nextDevice).length === 0) delete next[deviceId];
  else next[deviceId] = nextDevice;
  persist(next);
}

export function getAgentDeviceModelEffort(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): Effort | undefined {
  return readSlot(deviceId, agent, providerId, model)?.effortByModel[model];
}

export function setAgentDeviceModelEffort(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
): void {
  if (!effort) return;
  writeValue(deviceId, agent, providerId, model, 'effortByModel', effort);
}

export function clearAgentDeviceModelEffort(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): void {
  writeValue(deviceId, agent, providerId, model, 'effortByModel', undefined);
}

export function getAgentDeviceModelFast(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  return readSlot(deviceId, agent, providerId, model)?.fastByModel[model];
}

export function setAgentDeviceModelFast(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  writeValue(deviceId, agent, providerId, model, 'fastByModel', enabled);
}

export function clearAgentDeviceModelFast(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): void {
  writeValue(deviceId, agent, providerId, model, 'fastByModel', undefined);
}

export function getAgentDeviceModelThinking(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  return readSlot(deviceId, agent, providerId, model)?.thinkingByModel[model];
}

export function setAgentDeviceModelThinking(
  deviceId: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  writeValue(deviceId, agent, providerId, model, 'thinkingByModel', enabled);
}

/** 某台电脑的全部 override 快照(深拷贝);没有记录时返回 undefined。 */
export function snapshotAgentDeviceModelMemory(
  deviceId: string,
): AgentDeviceModelMemorySnapshot | undefined {
  const device = deviceId ? load()[deviceId] : undefined;
  if (!device) return undefined;
  const out: AgentDeviceModelMemorySnapshot = {};
  for (const [key, slot] of Object.entries(device)) {
    out[key] = {
      effortByModel: { ...slot.effortByModel },
      fastByModel: { ...slot.fastByModel },
      thinkingByModel: { ...slot.thinkingByModel },
    };
  }
  return out;
}

// 读写器按 deviceId 缓存,引用稳定(选择器 / 面板把它放进 memo 依赖)。读写都在调用时取当前
// owner 分区,所以切账号不需要重建。
const accessorsByDevice = new Map<string, ModelMemoryAccessors>();

/** 给模型选择器注入的读写器:读写这台电脑的档位记忆。 */
export function agentDeviceModelMemoryAccessors(deviceId: string): ModelMemoryAccessors {
  let accessors = accessorsByDevice.get(deviceId);
  if (!accessors) {
    accessors = {
      getEffort: (agent, providerId, model) =>
        getAgentDeviceModelEffort(deviceId, agent, providerId, model),
      setEffort: (agent, providerId, model, effort) =>
        setAgentDeviceModelEffort(deviceId, agent, providerId, model, effort),
      // 这里没有「来源上次选中的模型」要记,选中与只改档写的是同一份 override。
      setChoice: (agent, providerId, model, effort) =>
        setAgentDeviceModelEffort(deviceId, agent, providerId, model, effort),
      getFast: (agent, providerId, model) =>
        getAgentDeviceModelFast(deviceId, agent, providerId, model),
      setFast: (agent, providerId, model, enabled) =>
        setAgentDeviceModelFast(deviceId, agent, providerId, model, enabled),
      getThinking: (agent, providerId, model) =>
        getAgentDeviceModelThinking(deviceId, agent, providerId, model),
      setThinking: (agent, providerId, model, enabled) =>
        setAgentDeviceModelThinking(deviceId, agent, providerId, model, enabled),
      clearEffort: (agent, providerId, model) =>
        clearAgentDeviceModelEffort(deviceId, agent, providerId, model),
      clearFast: (agent, providerId, model) =>
        clearAgentDeviceModelFast(deviceId, agent, providerId, model),
    };
    accessorsByDevice.set(deviceId, accessors);
  }
  return accessors;
}

/** 随认证 dataOwnerId 切换命名空间,和 providerModelMemory / newMakerDraft 同步。 */
export function setAgentDeviceModelMemoryOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  activeDataOwnerId = normalized;
  cache = null;
  emit();
}

/** 测试用 —— 重置缓存 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  const keyBeforeReset = storageKey();
  cache = null;
  accessorsByDevice.clear();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(keyBeforeReset);
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  activeDataOwnerId = null;
}

export const __STORAGE_KEY = STORAGE_KEY;
