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
 * 持久化频率极低(仅用户点 dropdown 触发),同步写 localStorage,不做 batch / debounce
 * —— 与 newMakerDraft 的取舍一致(避免热更新 relaunch 强退丢最近一次改动)。
 *
 * 版本:STORAGE_KEY 为 v2(多槽)。冷启动时若只有历史 v1(单槽 {model,effort})数据,惰性迁移
 * 进缓存(下次 set 落盘到 v2),不破坏老用户的「来源 lastModel」连续性。
 */

import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

const STORAGE_KEY = 'xdt:providerModelMemory:v2';
/** 历史单槽版本 key —— 冷启动迁移源(只读,不再写)。 */
const LEGACY_STORAGE_KEY_V1 = 'xdt:providerModelMemory:v1';
/** v2 schema 内的保留来源 id:同一 agent 下跨真实 provider 共享的模型级预设槽。 */
export const MODEL_PRESET_SLOT_ID = '*';

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
    if (rec.effortByModel && typeof rec.effortByModel === 'object' && !Array.isArray(rec.effortByModel)) {
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
    if (rec.thinkingByModel && typeof rec.thinkingByModel === 'object' && !Array.isArray(rec.thinkingByModel)) {
      for (const [mid, tb] of Object.entries(rec.thinkingByModel as Record<string, unknown>)) {
        if (mid && typeof tb === 'boolean') thinkingByModel[mid] = tb;
      }
    }
    if (
      Object.keys(effortByModel).length === 0 &&
      Object.keys(fastByModel).length === 0 &&
      Object.keys(thinkingByModel).length === 0
    ) continue;
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
    if (typeof model === 'string' && model.length > 0 && typeof effort === 'string' && effort.length > 0) {
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

// 进程内缓存(惰性加载)。读多写少,避免每次读都 parse localStorage。
let cache: Record<string, ProviderMemory> | null = null;

function load(): Record<string, ProviderMemory> {
  if (cache) return cache;
  if (typeof window === 'undefined') {
    cache = {};
    return cache;
  }
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      cache = sanitize(JSON.parse(rawV2));
      return cache;
    }
    // 无 v2 → 尝试从历史 v1 迁移(只灌缓存,下次 set 再落盘 v2)。
    const rawV1 = window.localStorage.getItem(LEGACY_STORAGE_KEY_V1);
    cache = rawV1 ? migrateV1(JSON.parse(rawV1)) : {};
  } catch {
    cache = {};
  }
  return cache;
}

// 变更通知:device-link 被控端要把 providerModelMemory 镜像给 main(草稿列表行的真实读源),
// 控制端的镜像 / ModelSelector 也据此重渲染。persist 是唯一写路径(set* 同值短路后才到这里),
// 故在此统一 bump version + emit。
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

function persist(map: Record<string, ProviderMemory>): void {
  cache = map;
  emit();
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 满 / 私密窗口禁写 —— 忽略,不影响内存缓存。
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
  const map = load();
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
  const map = load();
  const providerKey = keyOf(agent, providerId);
  const provider = map[providerKey];
  const lastModel = updateLastModel ? model : (provider?.lastModel ?? '');
  if (provider?.lastModel === lastModel && provider.effortByModel[model] === effort) return;

  persist({
    ...map,
    [providerKey]: {
      lastModel,
      effortByModel: { ...(provider?.effortByModel ?? {}), [model]: effort },
      fastByModel: provider?.fastByModel ?? {},
      thinkingByModel: provider?.thinkingByModel ?? {},
    },
  });
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
  const map = load();
  const providerKey = keyOf(agent, providerId);
  const provider = map[providerKey];
  if (provider?.fastByModel?.[model] === enabled) return;
  persist({
    ...map,
    [providerKey]: {
      lastModel: provider?.lastModel ?? '',
      effortByModel: provider?.effortByModel ?? {},
      fastByModel: { ...(provider?.fastByModel ?? {}), [model]: enabled },
      thinkingByModel: provider?.thinkingByModel ?? {},
    },
  });
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
  const map = load();
  const providerKey = keyOf(agent, providerId);
  const provider = map[providerKey];
  if (provider?.thinkingByModel?.[model] === enabled) return;
  persist({
    ...map,
    [providerKey]: {
      lastModel: provider?.lastModel ?? '',
      effortByModel: provider?.effortByModel ?? {},
      fastByModel: provider?.fastByModel ?? {},
      thinkingByModel: { ...(provider?.thinkingByModel ?? {}), [model]: enabled },
    },
  });
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
  const map = load();
  const providerKey = keyOf(agent, providerId);
  const presetKey = presetKeyOf(agent);
  const nextProvider = withoutModelKey(map[providerKey], 'effortByModel', model);
  const nextPreset = withoutModelKey(map[presetKey], 'effortByModel', model);
  if (!nextProvider && !nextPreset) return;
  persist({
    ...map,
    ...(nextProvider ? { [providerKey]: nextProvider } : {}),
    ...(nextPreset ? { [presetKey]: nextPreset } : {}),
  });
}

/**
 * **删除**某 (agent, 模型) 的 Fast 记忆。语义同 clearProviderModelEffort:
 * 表里没有该键 ⇒ 跟随默认(读侧 `getProviderModelFast` 返回 undefined,调用方按「关」解释),
 * 而不是落一份「显式 false」的快照 —— 后者同样是把当前默认固化成用户配置。
 */
export function clearProviderModelFast(
  agent: AgentKind,
  providerId: string,
  model: string,
): void {
  if (!providerId || providerId === MODEL_PRESET_SLOT_ID || !model) return;
  const map = load();
  const providerKey = keyOf(agent, providerId);
  const presetKey = presetKeyOf(agent);
  const nextProvider = withoutModelKey(map[providerKey], 'fastByModel', model);
  const nextPreset = withoutModelKey(map[presetKey], 'fastByModel', model);
  if (!nextProvider && !nextPreset) return;
  persist({
    ...map,
    ...(nextProvider ? { [providerKey]: nextProvider } : {}),
    ...(nextPreset ? { [presetKey]: nextPreset } : {}),
  });
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

/** 测试用 —— 重置缓存 + 清 localStorage(其它代码不应调用)。 */
export function __resetForTest(): void {
  cache = null;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY_V1);
    } catch {
      // ignore
    }
  }
}

export const __STORAGE_KEY = STORAGE_KEY;
export const __LEGACY_STORAGE_KEY_V1 = LEGACY_STORAGE_KEY_V1;
