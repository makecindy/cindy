/**
 * deviceLinkModelMirror —— 控制端「纯显示镜像」：被控端每个 (agent, model) 的全局
 * effort/fast 预设,按 scope 隔离、进程内、不落盘。
 *
 * 为什么单独一份(而非复用控制端自己的 providerModelMemory):
 *   架构契约是「控制端纯镜像 / 被控端单一真相」(见 packages/device-link/src/topics.ts)。控制端
 *   显示被控端的模型列表时，**绝不**写控制端自己的本地记忆(那是控制端给自己本地项目用的)。
 *   远程项目的列表态只活在这份临时镜像里：初始由 pull(maker:get-new-maker-defaults 的
 *   providerModelMemory 字段)seed、被控端变更经 push 实时刷新；控制端编辑只乐观更新本镜像 + 经隧道
 *   通知被控端，真相由被控端回流。离开远程草稿 / 会话时 clearScope 清掉。
 *
 * scope 设计:
 *   - 草稿:`draft:${deviceId}` —— 一台被控设备的草稿列表(providerModelMemory 全量)。
 *   - 会话:`session:${sessionId}` —— 一个远程会话视图对被控端全局预设的临时镜像;scope 仅隔离
 *     控制端页面生命周期,内容仍来自被控端 providerModelMemory。
 * slot 设计与被控端 providerModelMemory snapshot 对齐:`${agent}:*` 是权威模型预设,
 * `${agent}:${providerId}` 是旧 v2 兼容副本。全局槽优先,旧快照没有它时回退来源槽。
 */

import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';
import type { ModelMemoryAccessors } from '@/components/new-chat/ModelSelector';

/** 单槽:被控端某 (agent, 来源) 下每个模型的 effort/fast 镜像。 */
interface Slot {
  effortByModel: Record<string, Effort>;
  fastByModel: Record<string, boolean>;
  thinkingByModel: Record<string, boolean>;
}

/** 被控端推 / 拉过来的全量快照形状(`${agent}:${providerId}` → Slot)。 */
export type RemoteModelMemorySnapshot = Record<
  string,
  {
    effortByModel: Record<string, string>;
    fastByModel: Record<string, boolean>;
    thinkingByModel?: Record<string, boolean>;
  }
>;

// scopeKey(`draft:<deviceId>` | `session:<sessionId>`)→ (slotKey `${agent}:${providerId}` → Slot)
const store = new Map<string, Map<string, Slot>>();
// 每个 scope 上次 replaceScope 的规范化序列化,用于同值短路(被控端 echo 整张快照、值常未变,
// 避免无谓重建 + emit → 重渲染所有 ModelSelector)。数据量小(几十条),JSON 序列化开销可忽略。
const scopeSerial = new Map<string, string>();

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
/** React hook —— 订阅镜像变更版本号,值变即重渲染(ModelSelector 行显示重算)。 */
export function useDeviceLinkModelMirrorVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function slotKey(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

/**
 * 用被控端全量快照整体替换某 scope 的镜像(初始 pull seed / push 全量刷新)。深拷贝入库,
 * 与调用方持有的快照解耦。同 scope 反复 replace 安全(幂等覆盖)。
 */
export function replaceScope(scopeKey: string, snapshot: RemoteModelMemorySnapshot | undefined): void {
  // 同值短路:被控端 echo 常整张快照不变 —— 序列化比对,未变则不重建、不 emit、不触发重渲染。
  const serial = JSON.stringify(snapshot ?? {});
  if (scopeSerial.get(scopeKey) === serial) return;
  scopeSerial.set(scopeKey, serial);
  const bySlot = new Map<string, Slot>();
  if (snapshot) {
    for (const [k, slot] of Object.entries(snapshot)) {
      bySlot.set(k, {
        effortByModel: { ...(slot.effortByModel as Record<string, Effort>) },
        fastByModel: { ...slot.fastByModel },
        thinkingByModel: { ...(slot.thinkingByModel ?? {}) },
      });
    }
  }
  store.set(scopeKey, bySlot);
  emit();
}

/** 清掉某 scope 的镜像(离开远程草稿 / 会话时调,避免泄漏)。 */
export function clearScope(scopeKey: string): void {
  scopeSerial.delete(scopeKey);
  if (store.delete(scopeKey)) emit();
}

function getSlot(scopeKey: string, agent: AgentKind, providerId: string, create: boolean): Slot | undefined {
  let bySlot = store.get(scopeKey);
  if (!bySlot) {
    if (!create) return undefined;
    bySlot = new Map();
    store.set(scopeKey, bySlot);
  }
  const k = slotKey(agent, providerId);
  let slot = bySlot.get(k);
  if (!slot && create) {
    slot = { effortByModel: {}, fastByModel: {}, thinkingByModel: {} };
    bySlot.set(k, slot);
  }
  return slot;
}

export function getMirrorEffort(
  scopeKey: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): Effort | undefined {
  if (!scopeKey || !providerId || !model) return undefined;
  return getSlot(scopeKey, agent, providerId, false)?.effortByModel[model];
}

export function getMirrorFast(
  scopeKey: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  if (!scopeKey || !providerId || !model) return undefined;
  return getSlot(scopeKey, agent, providerId, false)?.fastByModel[model];
}

/** 乐观本地写镜像(控制端编辑时 snappy 显示 / 被控端 push 回流时刷新)。同值短路。 */
export function setMirrorEffort(
  scopeKey: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  effort: Effort,
): void {
  if (!scopeKey || !providerId || !model || !effort) return;
  const providerSlot = getSlot(scopeKey, agent, providerId, true)!;
  if (providerSlot.effortByModel[model] === effort) return;
  providerSlot.effortByModel[model] = effort;
  scopeSerial.delete(scopeKey); // 直接改了 slot → 失效 replaceScope 同值缓存,下次全量 echo 必重新比对/应用
  emit();
}

export function getMirrorThinking(
  scopeKey: string,
  agent: AgentKind,
  providerId: string,
  model: string,
): boolean | undefined {
  if (!scopeKey || !providerId || !model) return undefined;
  return getSlot(scopeKey, agent, providerId, false)?.thinkingByModel?.[model];
}

export function setMirrorThinking(
  scopeKey: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  if (!scopeKey || !providerId || !model) return;
  const providerSlot = getSlot(scopeKey, agent, providerId, true)!;
  providerSlot.thinkingByModel ??= {};
  if (providerSlot.thinkingByModel[model] === enabled) return;
  providerSlot.thinkingByModel[model] = enabled;
  scopeSerial.delete(scopeKey);
  emit();
}

export function setMirrorFast(
  scopeKey: string,
  agent: AgentKind,
  providerId: string,
  model: string,
  enabled: boolean,
): void {
  if (!scopeKey || !providerId || !model) return;
  const providerSlot = getSlot(scopeKey, agent, providerId, true)!;
  if (providerSlot.fastByModel[model] === enabled) return;
  providerSlot.fastByModel[model] = enabled;
  scopeSerial.delete(scopeKey); // 同 setMirrorEffort:失效同值缓存
  emit();
}

/**
 * 给 ModelSelector 注入的 ModelMemoryAccessors:读镜像、写镜像 + 经 onWrite 通知被控端。
 * onWrite 由调用方按 scope 绑定具体隧道 channel(草稿 = apply-new-maker-draft-pref,
 * 会话 = set-session-model-pref);本工厂只负责「乐观写镜像 + 触发 onWrite」,不关心传输细节。
 */
export function makeMirrorAccessors(
  scopeKey: string,
  onWrite: (
    agent: AgentKind,
    providerId: string,
    model: string,
    patch: { effort?: Effort; fast?: boolean; thinking?: boolean; markModelChoice?: boolean },
  ) => void,
): ModelMemoryAccessors {
  return {
    getEffort: (agent, providerId, model) => getMirrorEffort(scopeKey, agent, providerId, model),
    getFast: (agent, providerId, model) => getMirrorFast(scopeKey, agent, providerId, model),
    getThinking: (agent, providerId, model) => getMirrorThinking(scopeKey, agent, providerId, model),
    setEffort: (agent, providerId, model, effort) => {
      setMirrorEffort(scopeKey, agent, providerId, model, effort);
      onWrite(agent, providerId, model, { effort });
    },
    setChoice: (agent, providerId, model, effort) => {
      setMirrorEffort(scopeKey, agent, providerId, model, effort);
      onWrite(agent, providerId, model, { effort, markModelChoice: true });
    },
    setFast: (agent, providerId, model, enabled) => {
      setMirrorFast(scopeKey, agent, providerId, model, enabled);
      onWrite(agent, providerId, model, { fast: enabled });
    },
    setThinking: (agent, providerId, model, enabled) => {
      setMirrorThinking(scopeKey, agent, providerId, model, enabled);
      onWrite(agent, providerId, model, { thinking: enabled });
    },
  };
}

/** 测试用 —— 清空整个进程内镜像(其它代码不应调用)。 */
export function __resetForTest(): void {
  store.clear();
  scopeSerial.clear();
  emit();
}
