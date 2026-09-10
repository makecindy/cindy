/**
 * draftModelMemory —— 新建会话草稿的「(被控设备, agent, 来源, 模型) → effort/fast」记忆,
 * AsyncStorage 持久化,跨冷启动生效(**除 AsyncStorage 外零 react-native**,node 可测)。
 *
 * 对位桌面 providerModelMemory(草稿场景那份 localStorage 记忆):模型选择列表里编辑
 * **非选中行**的 effort/fast 时写这里;选行时经共享 resolveEffort / resolveProviderSwitchEffort
 * 恢复(见 providerModelSections.resolveRowSelection)。选中行的 live 值不走这里(活在
 * draft state 里)。与桌面的两点有意差异:
 *   - 顶层多一维 deviceId:手机可控多台桌面,各设备的供应商集合(尤其自定义供应商 id)
 *     可能撞名,不分桶会跨设备串记忆;
 *   - 不做 lastModel:手机没有独立「切来源」入口(行点击总是带 modelId),用不上落点 hint。
 *
 * 读是同步内存缓存(hydrate 后可用),写是同步改缓存 + fire-and-forget 落盘(对齐
 * newSessionPreferenceStore 的容错:落盘失败静默,不影响内存态)。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@cindy/model-providers/types';

const STORAGE_KEY = 'xdtm:draftModelMemory:v1';

/**
 * 与桌面 ModelMemoryAccessors 同形(effort 用 string,消费边界自行窄化):模型选择列表
 * 对非选中行 effort/fast 的读写口。草稿注入 draftModelMemoryFor(deviceId),会话注入
 * sessionModelMirror 的 accessors,组件本身不耦合具体存储。
 */
export interface MobileModelMemoryAccessors {
  reset?(agent: AgentKind, providerId: string, modelId: string): Promise<void>;
  getEffort(agent: AgentKind, providerId: string, modelId: string): string | undefined;
  setEffort(agent: AgentKind, providerId: string, modelId: string, effort: string): void;
  getFast(agent: AgentKind, providerId: string, modelId: string): boolean | undefined;
  setFast(agent: AgentKind, providerId: string, modelId: string, enabled: boolean): void;
}

/** 单槽:某 (device, agent, 来源) 下每个模型的 effort/fast。 */
interface Slot {
  effortByModel: Record<string, string>;
  fastByModel: Record<string, boolean>;
}

// deviceId → (`${agent}:${providerId}` → Slot)
type MemoryMap = Record<string, Record<string, Slot>>;

let cache: MemoryMap = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;

const listeners = new Set<() => void>();
let version = 0;
function emit(): void {
  version++;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getVersion(): number {
  return version;
}
/** React hook —— 订阅记忆变更版本号(写入 / hydrate 完成时 bump,列表行显示重算)。 */
export function useDraftModelMemoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function slotKey(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

/** 严格校验落盘数据:只保留 effort 非空 string / fast boolean 的条目(对齐桌面 sanitize)。 */
function sanitize(raw: unknown): MemoryMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: MemoryMap = {};
  for (const [deviceId, slots] of Object.entries(raw as Record<string, unknown>)) {
    if (!deviceId || !slots || typeof slots !== 'object' || Array.isArray(slots)) continue;
    const outSlots: Record<string, Slot> = {};
    for (const [k, v] of Object.entries(slots as Record<string, unknown>)) {
      if (!k || !v || typeof v !== 'object') continue;
      const rec = v as { effortByModel?: unknown; fastByModel?: unknown };
      const effortByModel: Record<string, string> = {};
      if (rec.effortByModel && typeof rec.effortByModel === 'object' && !Array.isArray(rec.effortByModel)) {
        for (const [mid, eff] of Object.entries(rec.effortByModel as Record<string, unknown>)) {
          if (mid && typeof eff === 'string' && eff.length > 0) effortByModel[mid] = eff;
        }
      }
      const fastByModel: Record<string, boolean> = {};
      if (rec.fastByModel && typeof rec.fastByModel === 'object' && !Array.isArray(rec.fastByModel)) {
        for (const [mid, fb] of Object.entries(rec.fastByModel as Record<string, unknown>)) {
          if (mid && typeof fb === 'boolean') fastByModel[mid] = fb;
        }
      }
      if (Object.keys(effortByModel).length === 0 && Object.keys(fastByModel).length === 0) continue;
      outSlots[k] = { effortByModel, fastByModel };
    }
    if (Object.keys(outSlots).length > 0) out[deviceId] = outSlots;
  }
  return out;
}

/**
 * 幂等 hydrate:首帧调用,一次性从 AsyncStorage 灌内存缓存(灌完 bump version 触发重渲染)。
 * hydrate 前的读返回 undefined(行显示回落模型默认,数据到齐后自然刷新,不闪 loading)。
 */
export function hydrateDraftModelMemory(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydrating) return hydrating;
  hydrating = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (hydrated) return; // __resetForTest 竞态兜底
      cache = raw ? sanitize(JSON.parse(raw)) : {};
    })
    .catch(() => {
      cache = {};
    })
    .then(() => {
      hydrated = true;
      hydrating = null;
      emit();
    });
  return hydrating;
}

function persist(): void {
  emit();
  // fire-and-forget:落盘失败(磁盘满等)静默,内存态仍然生效。
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache)).catch(() => undefined);
}

function getSlot(deviceId: string, agent: AgentKind, providerId: string, create: boolean): Slot | undefined {
  let slots = cache[deviceId];
  if (!slots) {
    if (!create) return undefined;
    slots = {};
    cache[deviceId] = slots;
  }
  const k = slotKey(agent, providerId);
  let slot = slots[k];
  if (!slot && create) {
    slot = { effortByModel: {}, fastByModel: {} };
    slots[k] = slot;
  }
  return slot;
}

/** 取某被控设备的草稿记忆读写器(注入模型选择列表)。deviceId 空 → 全 no-op/undefined。 */
export function draftModelMemoryFor(deviceId: string): MobileModelMemoryAccessors {
  return {
    reset: async (agent, providerId, modelId) => {
      await hydrateDraftModelMemory();
      if (!deviceId || !providerId || !modelId) return;
      const slot = getSlot(deviceId, agent, providerId, false);
      if (!slot) return;
      const previousEffort = slot.effortByModel[modelId];
      const previousFast = slot.fastByModel[modelId];
      delete slot.effortByModel[modelId]; delete slot.fastByModel[modelId];
      try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); }
      catch (error) {
        // Retain concurrent edits, and restore only keys still absent from this attempted reset.
        if (slot.effortByModel[modelId] === undefined && previousEffort !== undefined) slot.effortByModel[modelId] = previousEffort;
        if (slot.fastByModel[modelId] === undefined && previousFast !== undefined) slot.fastByModel[modelId] = previousFast;
        emit(); throw error;
      }
      emit();
    },
    getEffort: (agent, providerId, modelId) => {
      if (!deviceId || !providerId || !modelId) return undefined;
      return getSlot(deviceId, agent, providerId, false)?.effortByModel[modelId];
    },
    setEffort: (agent, providerId, modelId, effort) => {
      if (!deviceId || !providerId || !modelId || !effort) return;
      const slot = getSlot(deviceId, agent, providerId, true)!;
      if (slot.effortByModel[modelId] === effort) return;
      slot.effortByModel[modelId] = effort;
      persist();
    },
    getFast: (agent, providerId, modelId) => {
      if (!deviceId || !providerId || !modelId) return undefined;
      return getSlot(deviceId, agent, providerId, false)?.fastByModel[modelId];
    },
    setFast: (agent, providerId, modelId, enabled) => {
      if (!deviceId || !providerId || !modelId) return;
      const slot = getSlot(deviceId, agent, providerId, true)!;
      if (slot.fastByModel[modelId] === enabled) return;
      slot.fastByModel[modelId] = enabled;
      persist();
    },
  };
}

/** 测试用 —— 重置内存态(不清 AsyncStorage,由测试 mock 自理)。 */
export function __resetForTest(): void {
  cache = {};
  hydrated = false;
  hydrating = null;
  version = 0;
}

export const __STORAGE_KEY = STORAGE_KEY;
