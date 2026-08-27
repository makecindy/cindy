/**
 * providerModelMemory —— 按「(agent, model) → effort / fast」记全局模型预设,外加每个来源
 * 「上次选中的模型」,localStorage 持久化,跨会话 / 跨重启在本机生效。
 *
 * 背景:
 *   用户把思考深度 / Fast 理解成「这个模型的默认设置」,而不是「这个来源下这个模型的设置」。
 *   因此在首页调整 Opus 后,其它对话里的 Opus 非选中行也必须立即看到同一预设,即便两个页面
 *   分别把 Opus 路由到 Anthropic / XD。当前正在使用 Opus 的会话仍由 live DB/runtime 值保护,
 *   只有切走再切回时才采用最新全局预设。
 *
 *   此前 renderer 有三层模型记忆:
 *     1) per-vendor 草稿默认(newMakerDraft.lastByVendor,历史上还有服务端全局单槽,已移除);
 *     2) per-session(sessions 表 model/effort/providerId 各一份);
 *     3) per-model effort(effortByModel,只按 modelId 记)。
 *   本 store 现在明确把模型预设放在 `${agent}:*` 全局槽,同时保留来源槽的 lastModel,用于切来源
 *   时落到正确的模型。来源槽里的 effort/fast 仅作为 v2 旧数据 / 旧客户端兼容副本,读取时全局槽优先。
 *
 * 谁读谁写:
 *   - 写:ChatInput —— 用户真正选定 (model, effort) 后更新全局模型预设 + 该来源 lastModel
 *         (setProviderModelChoice);只编辑非选中模型时仅更新预设、不改 lastModel
 *         (setProviderModelEffort)。
 *   - 读:
 *       · ModelSelector 的 resolveSourceSwitch —— 切来源时取该来源 lastModel + 其 effort
 *         (getProviderModelChoice)作为落点 hint;
 *       · ChatInput 的 effort 解析 —— 选回某 model 时恢复全局预设,再按目标来源 capability 校验
 *         (getProviderModelEffort)。
 *
 * key 设计:`${agentKind}:${providerId}` → ProviderMemory,`${agentKind}:*` → 全局模型预设。
 *   xd 来源同时服务 cc / codex 两个 agent,若只按 providerId 分槽,cc 会话与 codex 会话会
 *   互相覆盖对方在 xd 下的选择。agent 维度始终保留;只有同 agent 的同 model 才跨来源共享预设。
 *
 * 按 dataOwnerId 分区持久化；升级时首个稳定 owner 一次性认领旧设备全局快照，避免多账号
 * 互相继承 effort / Fast。持久化频率极低(仅用户点 dropdown 触发),同步写 localStorage,不做 batch / debounce
 * —— 与 newMakerDraft 的取舍一致(避免热更新 relaunch 强退丢最近一次改动)。
 *
 * 版本:STORAGE_KEY 为 v2(多槽)。未建立 owner 分区前若只有历史 v1(单槽 {model,effort})
 * 数据,仍可迁移为首个 owner 的 v2 快照,不破坏老用户的「来源 lastModel」连续性。
 */

import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

const STORAGE_KEY = 'xdt:providerModelMemory:v2';
/** 历史单槽版本 key —— 冷启动迁移源(只读,不再写)。 */
const LEGACY_STORAGE_KEY_V1 = 'xdt:providerModelMemory:v1';
/** v2 schema 内的保留来源 id:同一 agent 下跨真实 provider 共享的模型级预设槽。 */
export const MODEL_PRESET_SLOT_ID = '*';

let activeDataOwnerId: string | null = null;

function ownerStorageKey(ownerId: string): string {
  return `${STORAGE_KEY}:${encodeURIComponent(ownerId)}`;
}

function storageKey(): string {
  return activeDataOwnerId ? ownerStorageKey(activeDataOwnerId) : STORAGE_KEY;
}

/**
 * 单个来源槽:真实来源槽记「上次选中的模型」+ 兼容副本;`*` 槽记权威模型级 effort / fast。
 * lastModel 可为空(只记过 effort/fast 没法确定 lastModel 的脏数据);
 * effortByModel / fastByModel 至少一边非空才保留。
 */
interface ProviderMemory {
  lastModel: string;
  effortByModel: Record<string, Effort>;
  fastByModel: Record<string, boolean>;
  thinkingByModel: Record<string, boolean>;
}

/** getProviderModelChoice 的返回形状(该来源上次的 model + 其 effort)。供 resolveSourceSwitch 消费。 */
export interface ProviderModelChoice {
  model: string;
  effort: Effort;
}

function keyOf(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

function presetKeyOf(agent: AgentKind): string {
  return keyOf(agent, MODEL_PRESET_SLOT_ID);
}

/**
 * 严格校验 v2:每个槽收敛成 { lastModel, effortByModel },其中 effortByModel 只保留
 * model / effort 都是非空 string 的条目;effortByModel 为空的槽整条丢弃(无可恢复信息)。
 * 老版本 / 手改 localStorage 损坏时静默回退空表(不抛)。
 */
function sanitize(raw: unknown): Record<string, ProviderMemory> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ProviderMemory> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !v || typeof v !== 'object') continue;
    const rec = v as {
      lastModel?: unknown;
      effortByModel?: unknown;
      fastByModel?: unknown;
      thinkingByModel?: unknown;
    };
    const effortByModel: Record<string, Effort> = {};
    if (
      rec.effortByModel &&
      typeof rec.effortByModel === 'object' &&
      !Array.isArray(rec.effortByModel)
    ) {
      for (const [mid, eff] of Object.entries(rec.effortByModel as Record<string, unknown>)) {
        if (mid && typeof eff === 'string' && eff.length > 0) effortByModel[mid] = eff as Effort;
      }
    }
    const fastByModel: Record<string, boolean> = {};
    if (rec.fastByModel && typeof rec.fastByModel === 'object' && !Array.isArray(rec.fastByModel)) {
      for (const [mid, fb] of Object.entries(rec.fastByModel as Record<string, unknown>)) {
        if (mid && typeof fb === 'boolean') fastByModel[mid] = fb;
      }
    }
    const thinkingByModel: Record<string, boolean> = {};
    if (
      rec.thinkingByModel &&
      typeof rec.thinkingByModel === 'object' &&
      !Array.isArray(rec.thinkingByModel)
    ) {
      for (const [mid, tb] of Object.entries(rec.thinkingByModel as Record<string, unknown>)) {
        if (mid && typeof tb === 'boolean') thinkingByModel[mid] = tb;
      }
    }
    if (
      Object.keys(effortByModel).length === 0 &&
      Object.keys(fastByModel).length === 0 &&
      Object.keys(thinkingByModel).length === 0
    )
      continue;
    out[k] = {
      lastModel: typeof rec.lastModel === 'string' ? rec.lastModel : '',
      effortByModel,
      fastByModel,
      thinkingByModel,
    };
  }
  return out;
}

/** 迁移历史 v1 单槽({model,effort})→ v2 多槽({lastModel:model, effortByModel:{model:effort}})。 */
function migrateV1(raw: unknown): Record<string, ProviderMemory> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ProviderMemory> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !v || typeof v !== 'object') continue;
    const model = (v as { model?: unknown }).model;
    const effort = (v as { effort?: unknown }).effort;
    if (
      typeof model === 'string' &&
      model.length > 0 &&
      typeof effort === 'string' &&
      effort.length > 0
    ) {
      out[k] = {
        lastModel: model,
        effortByModel: { [model]: effort as Effort },
        fastByModel: {},
        thinkingByModel: {},
      };
    }
  }
  return out;
}

/**
 * 旧版只有一份设备全局快照。升级后的第一个稳定 owner 一次性认领它；随后删除旧 key，
 * 其它账号只读各自命名空间，避免 A 的 effort / Fast 让 B 被误判为已自定义。
 */
function migrateLegacyToOwner(ownerId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const scopedKey = ownerStorageKey(ownerId);
    if (window.localStorage.getItem(scopedKey) !== null) return;

    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    const rawV1 = window.localStorage.getItem(LEGACY_STORAGE_KEY_V1);
    const migrated = rawV2
      ? sanitize(JSON.parse(rawV2))
      : rawV1
        ? migrateV1(JSON.parse(rawV1))
        : null;
    if (!migrated) return;

    window.localStorage.setItem(scopedKey, JSON.stringify(migrated));
    if (window.localStorage.getItem(scopedKey) === null) return;
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
  } catch {
    // 认领失败时保留旧 key；当前 owner 按空分区运行，绝不把未归属数据串给其它账号。
  }
}

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: Record<string, ProviderMemory> | null = null;

/** 一次用户写入的最小表达；写盘失败后重放到最新共享快照，不能保存并覆盖整张旧表。 */
type ProviderMemoryOp =
  | {
      kind: 'set-effort';
      agent: AgentKind;
      providerId: string;
      model: string;
      effort: Effort;
    }
  | { kind: 'set-last-model'; agent: AgentKind; providerId: string; model: string }
  | { kind: 'set-fast'; agent: AgentKind; providerId: string; model: string; enabled: boolean }
  | { kind: 'set-thinking'; agent: AgentKind; providerId: string; model: string; enabled: boolean }
  | { kind: 'clear-effort'; agent: AgentKind; providerId: string; model: string }
  | { kind: 'clear-fast'; agent: AgentKind; providerId: string; model: string };

interface PendingProviderMemoryOp {
  op: ProviderMemoryOp;
  /** 首次写失败前该字段的共享值；恢复时已变化说明别窗有更新，本旧操作必须退休。 */
  baseline: {
    providerValue: Effort | boolean | undefined;
    lastModel: string;
    presetValue: Effort | boolean | undefined;
  };
  conflictKey: string;
}

/** localStorage 临时不可写时只留本窗口未落盘的操作，按 owner 隔离。 */
const pendingOpsByStorageKey = new Map<string, PendingProviderMemoryOp[]>();
const MAX_PENDING_OPS_PER_KEY = 100;

function sameRecord<T extends string | boolean>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function sameMap(
  left: Record<string, ProviderMemory>,
  right: Record<string, ProviderMemory>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => {
      const a = left[key];
      const b = right[key];
      return Boolean(
        a &&
        b &&
        a.lastModel === b.lastModel &&
        sameRecord(a.effortByModel, b.effortByModel) &&
        sameRecord(a.fastByModel, b.fastByModel) &&
        sameRecord(a.thinkingByModel, b.thinkingByModel),
      );
    })
  );
}

function applyProviderMemoryOp(
  map: Record<string, ProviderMemory>,
  op: ProviderMemoryOp,
): Record<string, ProviderMemory> {
  const providerKey = keyOf(op.agent, op.providerId);
  const provider = map[providerKey];
  if (op.kind === 'set-effort') {
    if (provider?.effortByModel[op.model] === op.effort) return map;
    return {
      ...map,
      [providerKey]: {
        lastModel: provider?.lastModel ?? '',
        effortByModel: { ...(provider?.effortByModel ?? {}), [op.model]: op.effort },
        fastByModel: provider?.fastByModel ?? {},
        thinkingByModel: provider?.thinkingByModel ?? {},
      },
    };
  }
  if (op.kind === 'set-last-model') {
    if (provider?.lastModel === op.model) return map;
    return {
      ...map,
      [providerKey]: {
        lastModel: op.model,
        effortByModel: provider?.effortByModel ?? {},
        fastByModel: provider?.fastByModel ?? {},
        thinkingByModel: provider?.thinkingByModel ?? {},
      },
    };
  }
  if (op.kind === 'set-fast') {
    if (provider?.fastByModel?.[op.model] === op.enabled) return map;
    return {
      ...map,
      [providerKey]: {
        lastModel: provider?.lastModel ?? '',
        effortByModel: provider?.effortByModel ?? {},
        fastByModel: { ...(provider?.fastByModel ?? {}), [op.model]: op.enabled },
        thinkingByModel: provider?.thinkingByModel ?? {},
      },
    };
  }
  if (op.kind === 'set-thinking') {
    if (provider?.thinkingByModel?.[op.model] === op.enabled) return map;
    return {
      ...map,
      [providerKey]: {
        lastModel: provider?.lastModel ?? '',
        effortByModel: provider?.effortByModel ?? {},
        fastByModel: provider?.fastByModel ?? {},
        thinkingByModel: { ...(provider?.thinkingByModel ?? {}), [op.model]: op.enabled },
      },
    };
  }

  const field = op.kind === 'clear-effort' ? 'effortByModel' : 'fastByModel';
  const presetKey = presetKeyOf(op.agent);
  const nextProvider = withoutModelKey(provider, field, op.model);
  const nextPreset = withoutModelKey(map[presetKey], field, op.model);
  if (!nextProvider && !nextPreset) return map;
  return {
    ...map,
    ...(nextProvider ? { [providerKey]: nextProvider } : {}),
    ...(nextPreset ? { [presetKey]: nextPreset } : {}),
  };
}

function opDimension(op: ProviderMemoryOp): 'effort' | 'fast' | 'thinking' | 'last-model' {
  if (op.kind === 'set-last-model') return 'last-model';
  if (op.kind === 'set-thinking') return 'thinking';
  if (op.kind === 'set-fast' || op.kind === 'clear-fast') return 'fast';
  return 'effort';
}

function opConflictKey(op: ProviderMemoryOp): string {
  if (op.kind === 'set-last-model') return `${keyOf(op.agent, op.providerId)}:last-model`;
  return `${keyOf(op.agent, op.providerId)}:${op.model}:${opDimension(op)}`;
}

/** 捕获该维度的完整基线；匹配时再按最终 op 的实际写集选字段。 */
function captureOpConflictBaseline(
  map: Record<string, ProviderMemory>,
  op: ProviderMemoryOp,
): PendingProviderMemoryOp['baseline'] {
  const provider = map[keyOf(op.agent, op.providerId)];
  if (op.kind === 'set-last-model') {
    return {
      providerValue: undefined,
      lastModel: provider?.lastModel ?? '',
      presetValue: undefined,
    };
  }
  if (opDimension(op) === 'thinking') {
    return {
      providerValue: provider?.thinkingByModel[op.model],
      lastModel: provider?.lastModel ?? '',
      presetValue: undefined,
    };
  }
  const preset = map[presetKeyOf(op.agent)];
  if (opDimension(op) === 'fast') {
    return {
      providerValue: provider?.fastByModel[op.model],
      lastModel: provider?.lastModel ?? '',
      presetValue: preset?.fastByModel[op.model],
    };
  }
  return {
    providerValue: provider?.effortByModel[op.model],
    lastModel: provider?.lastModel ?? '',
    presetValue: preset?.effortByModel[op.model],
  };
}

/** 只比较最终 op 真正会写的字段；其它模型/维度变化可安全合并。 */
function matchesOpConflictBaseline(
  map: Record<string, ProviderMemory>,
  pending: PendingProviderMemoryOp,
): boolean {
  const { op, baseline } = pending;
  const current = captureOpConflictBaseline(map, op);
  if (op.kind === 'set-last-model') return current.lastModel === baseline.lastModel;
  if (current.providerValue !== baseline.providerValue) return false;
  if (op.kind === 'clear-effort' || op.kind === 'clear-fast') {
    return current.presetValue === baseline.presetValue;
  }
  return true;
}

function recordPendingOp(
  key: string,
  op: ProviderMemoryOp,
  base: Record<string, ProviderMemory>,
): void {
  const conflictKey = opConflictKey(op);
  const current = pendingOpsByStorageKey.get(key) ?? [];
  const previous = current.find((entry) => entry.conflictKey === conflictKey);
  const next = [
    ...current.filter((entry) => entry.conflictKey !== conflictKey),
    {
      op,
      conflictKey,
      // 同字段多次失败只保留最终意图，但基线必须是第一次失败前的共享值。
      baseline: previous?.baseline ?? captureOpConflictBaseline(base, op),
    },
  ];
  pendingOpsByStorageKey.set(key, next.slice(-MAX_PENDING_OPS_PER_KEY));
}

function applyPendingOps(
  key: string,
  map: Record<string, ProviderMemory>,
): Record<string, ProviderMemory> {
  let next = map;
  const pendingOps = pendingOpsByStorageKey.get(key) ?? [];
  const survivors: PendingProviderMemoryOp[] = [];
  for (const pending of pendingOps) {
    if (!matchesOpConflictBaseline(next, pending)) continue;
    survivors.push(pending);
    next = applyProviderMemoryOp(next, pending.op);
  }
  if (survivors.length !== pendingOps.length) {
    if (survivors.length > 0) pendingOpsByStorageKey.set(key, survivors);
    else pendingOpsByStorageKey.delete(key);
  }
  return next;
}

function loadFromStorage(): Record<string, ProviderMemory> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey());
    return raw ? sanitize(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function load(): Record<string, ProviderMemory> {
  if (cache) return cache;
  const key = storageKey();
  if (typeof window === 'undefined') {
    cache = {};
    return cache;
  }
  try {
    const rawV2 = window.localStorage.getItem(storageKey());
    if (rawV2) {
      cache = applyPendingOps(key, sanitize(JSON.parse(rawV2)));
      return cache;
    }
    // 无 v2 → 尝试从历史 v1 迁移(只灌缓存,下次 set 再落盘 v2)。
    const rawV1 = activeDataOwnerId ? null : window.localStorage.getItem(LEGACY_STORAGE_KEY_V1);
    cache = applyPendingOps(key, rawV1 ? migrateV1(JSON.parse(rawV1)) : {});
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * 整表写回前重读当前 owner 分区，避免另一个 renderer 刚写入的 override 被本窗口旧缓存覆盖。
 * localStorage 不可读时保留本窗口内存态，不能用空表抹掉尚未成功持久化的用户选择。
 */
function freshMap(): Record<string, ProviderMemory> {
  if (typeof window === 'undefined') return load();
  const key = storageKey();
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey());
  } catch {
    return load();
  }
  if (raw === null) return load();
  try {
    const stored = sanitize(JSON.parse(raw));
    const next = applyPendingOps(key, stored);
    if (pendingOpsByStorageKey.has(key)) {
      try {
        if (!sameMap(stored, next)) window.localStorage.setItem(key, JSON.stringify(next));
        pendingOpsByStorageKey.delete(key);
      } catch {
        // 仍不可写：保留最小 op，下一次写入继续在最新共享快照上重放。
      }
    }
    if (cache === null || !sameMap(cache, next)) {
      cache = next;
      emit();
    }
    return next;
  } catch {
    return load();
  }
}

// 变更通知:device-link 被控端要把 providerModelMemory 镜像给 main(草稿列表行的真实读源),
// 控制端的镜像 / ModelSelector 也据此重渲染。本窗口 persist 与其它 renderer 的 storage 事件
// 都在采纳最新缓存后 bump version + emit。
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
/** React hook —— 订阅 providerModelMemory 变更版本号(useSyncExternalStore)。 */
export function useProviderModelMemoryVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}
/** 订阅 providerModelMemory 变更(非 React,如 App.tsx 把快照镜像给 main)。 */
export function subscribeProviderModelMemory(listener: () => void): () => void {
  return subscribe(listener);
}

const removeStorageListener = (() => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return null;
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== storageKey()) return;
    // storage 事件可能迟到，event.newValue 不是当前真相；始终重读当前 owner 分区。
    const next = applyPendingOps(storageKey(), loadFromStorage());
    if (cache !== null && sameMap(cache, next)) return;
    cache = next;
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

/**
 * 是否已有任一模型级预设 override。
 *
 * 旧版本可能只在本表留下 effort / Fast（或 thinking）而没有 newMakerDraft 的模型标记；
 * 这些仍是明确的用户设置，连接态默认组合不得把它们覆盖掉。
 */
export function hasAnyProviderModelOverride(): boolean {
  return Object.values(load()).some(
    (slot) =>
      Object.keys(slot.effortByModel).length > 0 ||
      Object.keys(slot.fastByModel).length > 0 ||
      Object.keys(slot.thinkingByModel).length > 0,
  );
}

function persist(
  map: Record<string, ProviderMemory>,
  ops: ProviderMemoryOp[],
  base: Record<string, ProviderMemory>,
): void {
  const key = storageKey();
  cache = map;
  emit();
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
    pendingOpsByStorageKey.delete(key);
  } catch {
    // 只记最小操作；恢复可写后重放到最新共享快照，不能用本窗口旧整表覆盖另一 renderer。
    for (const op of ops) recordPendingOp(key, op, base);
  }
}

/**
 * 读某 (agent, 来源) 上次选中的 (model, effort);无记录 / 无法确定 lastModel 返回 undefined。
 * 用于切来源时决定落到哪个模型 + 哪一档(resolveSourceSwitch)。
 */
export function getProviderModelChoice(
  agent: AgentKind,
  providerId: string,
): ProviderModelChoice | undefined {
  if (!providerId) return undefined;
  const rec = load()[keyOf(agent, providerId)];
  if (!rec || !rec.lastModel) return undefined;
  const effort = rec.effortByModel[rec.lastModel];
  return effort ? { model: rec.lastModel, effort } : undefined;
}

/**
 * 读某 (agent, 模型) 的全局 effort;providerId 只用于兼容读取旧 v2 来源槽。
 * 新全局值优先,所以同模型跨来源 / 跨对话共享;旧数据尚未产生全局值时仍能按原来源恢复。
 */
export function getProviderModelEffort(
  agent: AgentKind,
  providerId: string,
  model: string,
): Effort | undefined {
  if (!providerId || !model) return undefined;
  const map = load();
  return map[keyOf(agent, providerId)]?.effortByModel[model];
}

function setModelEffort(
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
  updateLastModel: boolean,
): void {
  if (!providerId || providerId === MODEL_PRESET_SLOT_ID || !model || !effort) return;
  const map = freshMap();
  const ops: ProviderMemoryOp[] = [
    { kind: 'set-effort', agent, providerId, model, effort },
    ...(updateLastModel
      ? [{ kind: 'set-last-model', agent, providerId, model } as ProviderMemoryOp]
      : []),
  ];
  const next = ops.reduce(applyProviderMemoryOp, map);
  if (next === map) return;
  persist(next, ops, map);
}

/** 只更新模型级全局 effort,不把「编辑非选中模型」误记为该来源上次选中的模型。 */
export function setProviderModelEffort(
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
): void {
  setModelEffort(agent, providerId, model, effort, false);
}

/**
 * 写用户真正选定的 (model, effort):更新该来源 lastModel + 模型级全局 effort。
 * 同时保留来源兼容副本,供旧 v2 客户端 / 旧 device-link 快照继续工作。
 */
export function setProviderModelChoice(
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
): void {
  setModelEffort(agent, providerId, model, effort, true);
}

/**
 * 读某 (agent, 模型) 的全局 fast;providerId 只用于兼容读取旧 v2 来源槽。
 */
export function getProviderModelFast(
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  if (!providerId || !model) return undefined;
  const map = load();
  return map[keyOf(agent, providerId)]?.fastByModel?.[model];
}

/**
 * 写某 (agent, 模型) 的全局 fast,同时保留来源兼容副本;不动 effort / lastModel。同值短路。
 */
export function setProviderModelFast(
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  if (!providerId || providerId === MODEL_PRESET_SLOT_ID || !model) return;
  const map = freshMap();
  const op: ProviderMemoryOp = { kind: 'set-fast', agent, providerId, model, enabled };
  const next = applyProviderMemoryOp(map, op);
  if (next === map) return;
  persist(next, [op], map);
}

export function getProviderModelThinking(
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  if (!providerId || !model) return undefined;
  return load()[keyOf(agent, providerId)]?.thinkingByModel?.[model];
}

export function setProviderModelThinking(
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  if (!providerId || providerId === MODEL_PRESET_SLOT_ID || !model) return;
  const map = freshMap();
  const op: ProviderMemoryOp = { kind: 'set-thinking', agent, providerId, model, enabled };
  const next = applyProviderMemoryOp(map, op);
  if (next === map) return;
  persist(next, [op], map);
}

/**
 * 从某个槽里删掉一个模型键(effort / fast 任一维),不动同槽其余键与 lastModel。
 * 槽不存在或该键本就没有 → 返回 null 表示「无事可做」(调用方据此短路,不做无意义落盘)。
 */
function withoutModelKey(
  slot: ProviderMemory | undefined,
  field: 'effortByModel' | 'fastByModel',
  model: string,
): ProviderMemory | null {
  if (!slot || !(model in slot[field])) return null;
  const nextField = { ...slot[field] };
  delete nextField[model];
  return { ...slot, [field]: nextField } as ProviderMemory;
}

/**
 * **删除**某 (agent, 模型) 的深度记忆 —— 「恢复推荐 / 回落默认」的正确语义
 * (configuration-and-overrides §4:override 表里没有该键 ⇒ 跟随当前版本的默认,而不是
 * 把这一版的默认**快照**写进用户配置)。写快照的老做法会把用户钉死在旧默认上:服务端
 * 之后改了推荐档,没自定义过的用户吃不到。
 *
 * 权威的 `${agent}:*` 全局槽与来源兼容副本**两处都要删**:读路径是「全局优先、来源兜底」
 * (getProviderModelEffort),只删一处的话另一处会把旧值顶回来。
 */
export function clearProviderModelEffort(
  agent: AgentKind,
  providerId: string,
  model: string,
): void {
  if (!providerId || providerId === MODEL_PRESET_SLOT_ID || !model) return;
  const map = freshMap();
  const op: ProviderMemoryOp = { kind: 'clear-effort', agent, providerId, model };
  const next = applyProviderMemoryOp(map, op);
  if (next === map) return;
  persist(next, [op], map);
}

/**
 * **删除**某 (agent, 模型) 的 Fast 记忆。语义同 clearProviderModelEffort:
 * 表里没有该键 ⇒ 跟随默认(读侧 `getProviderModelFast` 返回 undefined,调用方按「关」解释),
 * 而不是落一份「显式 false」的快照 —— 后者同样是把当前默认固化成用户配置。
 */
export function clearProviderModelFast(agent: AgentKind, providerId: string, model: string): void {
  if (!providerId || providerId === MODEL_PRESET_SLOT_ID || !model) return;
  const map = freshMap();
  const op: ProviderMemoryOp = { kind: 'clear-fast', agent, providerId, model };
  const next = applyProviderMemoryOp(map, op);
  if (next === map) return;
  persist(next, [op], map);
}

/**
 * 快照当前全部槽的 (effortByModel, fastByModel, thinkingByModel)(丢弃 lastModel)。
 * 用于 renderer → main 缓存和 device-link 控制端镜像被控设备的全局模型预设。
 * 深拷贝,调用方拿到的快照不随后续本地改动变化。
 */
export function snapshotForSeed(): Record<
  string,
  {
    effortByModel: Record<string, Effort>;
    fastByModel: Record<string, boolean>;
    thinkingByModel: Record<string, boolean>;
  }
> {
  const out: Record<
    string,
    {
      effortByModel: Record<string, Effort>;
      fastByModel: Record<string, boolean>;
      thinkingByModel: Record<string, boolean>;
    }
  > = {};
  for (const [k, slot] of Object.entries(load())) {
    out[k] = {
      effortByModel: { ...slot.effortByModel },
      fastByModel: { ...slot.fastByModel },
      thinkingByModel: { ...slot.thinkingByModel },
    };
  }
  return out;
}

/** 随认证 dataOwnerId 切换模型预设命名空间，和 newMakerDraft / modelEnginePrefs 同步。 */
export function setProviderModelMemoryOwner(ownerId: string | null): void {
  const normalized = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId : null;
  if (activeDataOwnerId === normalized) return;
  if (normalized) migrateLegacyToOwner(normalized);
  activeDataOwnerId = normalized;
  cache = null;
  emit();
}

/** 测试用 —— 重置缓存 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  const keyBeforeReset = storageKey();
  cache = null;
  pendingOpsByStorageKey.clear();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(keyBeforeReset);
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
    } catch {
      // ignore
    }
  }
  activeDataOwnerId = null;
}

export const __STORAGE_KEY = STORAGE_KEY;
export const __LEGACY_STORAGE_KEY_V1 = LEGACY_STORAGE_KEY_V1;
