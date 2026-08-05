/**
 * sessionModelMirror —— 会话内模型列表「非选中行」effort/fast 的**纯显示镜像**
 * (进程内、不落盘,**纯逻辑,零 react-native**,useSyncExternalStore 例外由 react 提供)。
 *
 * 架构契约对齐桌面 deviceLinkModelMirror:「控制端纯镜像 / 被控端单一真相」。手机永远是
 * device-link 控制端,会话内非选中行的记忆**绝不落手机本地**(否则与被控端、桌面控制端
 * 三方分叉):
 *   - 手机编辑非选中行 → 乐观写本镜像 + 经 onWrite 隧道写穿被控端
 *     (maker:set-session-model-pref + maker:apply-new-maker-draft-pref 双写,老被控端吞掉降级);
 *   - 被控端本地改 / 应用任何控制端写 → 广播 maker:session-model-pref:changed(增量),
 *     remoteSessionStore 路由到 applySessionModelPrefPush 刷新镜像;
 *   - 离开会话 clearSessionMirror,防泄漏。
 * 镜像初始为空(非选中行先显示模型默认),与桌面 push 增量口径一致;手机不做全量 seed
 * (桌面草稿场景才有 replaceScope)。
 */
import { useSyncExternalStore } from 'react';

import type { AgentKind } from '@cindy/model-providers/types';

import type { MobileModelMemoryAccessors } from './draftModelMemory';

/** 单槽:某 (agent, 来源) 下每个模型的 effort/fast 镜像。 */
interface Slot {
  effortByModel: Record<string, string>;
  fastByModel: Record<string, boolean>;
}

// sessionId → (`${agent}:${providerId}` → Slot)
const store = new Map<string, Map<string, Slot>>();

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
/** React hook —— 订阅镜像变更版本号(push 回流 / 乐观写时 bump,列表行显示重算)。 */
export function useSessionModelMirrorVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

function slotKey(agent: AgentKind, providerId: string): string {
  return `${agent}:${providerId}`;
}

function getSlot(sessionId: string, agent: AgentKind, providerId: string, create: boolean): Slot | undefined {
  let bySlot = store.get(sessionId);
  if (!bySlot) {
    if (!create) return undefined;
    bySlot = new Map();
    store.set(sessionId, bySlot);
  }
  const k = slotKey(agent, providerId);
  let slot = bySlot.get(k);
  if (!slot && create) {
    slot = { effortByModel: {}, fastByModel: {} };
    bySlot.set(k, slot);
  }
  return slot;
}

function setMirrorEffort(sessionId: string, agent: AgentKind, providerId: string, model: string, effort: string): void {
  if (!sessionId || !providerId || !model || !effort) return;
  const slot = getSlot(sessionId, agent, providerId, true)!;
  if (slot.effortByModel[model] === effort) return;
  slot.effortByModel[model] = effort;
  emit();
}

function setMirrorFast(sessionId: string, agent: AgentKind, providerId: string, model: string, enabled: boolean): void {
  if (!sessionId || !providerId || !model) return;
  const slot = getSlot(sessionId, agent, providerId, true)!;
  if (slot.fastByModel[model] === enabled) return;
  slot.fastByModel[model] = enabled;
  emit();
}

/**
 * 应用被控端 push(maker:session-model-pref:changed,payload 形状:
 * { sessionId, agent, providerId, model, effort?, fast? } 增量)。非法 payload 静默忽略。
 */
export function applySessionModelPrefPush(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as {
    sessionId?: unknown;
    agent?: unknown;
    providerId?: unknown;
    model?: unknown;
    effort?: unknown;
    fast?: unknown;
  };
  if (typeof p.sessionId !== 'string' || !p.sessionId) return;
  if (p.agent !== 'claude-code' && p.agent !== 'codex' && p.agent !== 'pi') return;
  if (typeof p.providerId !== 'string' || !p.providerId) return;
  if (typeof p.model !== 'string' || !p.model) return;
  if (typeof p.effort === 'string' && p.effort.length > 0) {
    setMirrorEffort(p.sessionId, p.agent, p.providerId, p.model, p.effort);
  }
  if (typeof p.fast === 'boolean') {
    setMirrorFast(p.sessionId, p.agent, p.providerId, p.model, p.fast);
  }
}

/** 清掉某会话的镜像(离开会话页时调,避免泄漏)。 */
export function clearSessionMirror(sessionId: string): void {
  if (store.delete(sessionId)) emit();
}

/**
 * 给模型选择列表注入的 accessors:读镜像、写镜像 + 经 onWrite 写穿被控端。
 * onWrite 由调用方绑定隧道调用(set-session-model-pref + apply-new-maker-draft-pref 双写,
 * 失败吞掉降级);本工厂只负责「乐观写镜像 + 触发 onWrite」,不关心传输细节。
 */
export function makeSessionMirrorAccessors(
  sessionId: string,
  onWrite: (
    agent: AgentKind,
    providerId: string,
    model: string,
    patch: { effort?: string; fast?: boolean },
  ) => void,
): MobileModelMemoryAccessors {
  return {
    getEffort: (agent, providerId, model) =>
      getSlot(sessionId, agent, providerId, false)?.effortByModel[model],
    getFast: (agent, providerId, model) =>
      getSlot(sessionId, agent, providerId, false)?.fastByModel[model],
    setEffort: (agent, providerId, model, effort) => {
      setMirrorEffort(sessionId, agent, providerId, model, effort);
      onWrite(agent, providerId, model, { effort });
    },
    setFast: (agent, providerId, model, enabled) => {
      setMirrorFast(sessionId, agent, providerId, model, enabled);
      onWrite(agent, providerId, model, { fast: enabled });
    },
  };
}

/** 测试用 —— 清空整个进程内镜像(其它代码不应调用)。 */
export function __resetForTest(): void {
  store.clear();
  version = 0;
}
