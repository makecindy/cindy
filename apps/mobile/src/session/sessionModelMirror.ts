/**
 * sessionModelMirror —— 会话内模型列表「非选中行」effort/fast 的**纯显示镜像**
 * (进程内、不落盘,**纯逻辑,零 react-native**,useSyncExternalStore 例外由 react 提供)。
 *
 * 架构契约对齐桌面 deviceLinkModelMirror:「控制端纯镜像 / 被控端单一真相」。手机永远是
 * device-link 控制端,会话内非选中行的记忆**绝不落手机本地**(否则与被控端、桌面控制端
 * 三方分叉):
 *   - 手机编辑非选中行 → 乐观写本镜像 + 经 onWrite 隧道写穿被控端
 *     (maker:set-session-model-pref + maker:apply-new-maker-draft-pref 双写,被控端收下任一条即写到;
 *     两条都没收下 = 没写到:撤回乐观值并告诉调用方,不能显示成已保存);
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
  fastByModel: Record<string, boolean | 'ultrafast'>;
  /** 每个值最近一次被写下的序号(本机乐观写、被控端推送都记,同值也记),撤回靠它认出「还是我写的那次」。 */
  effortStamp: Record<string, number>;
  fastStamp: Record<string, number>;
}

let stampSeq = 0;

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
    slot = { effortByModel: {}, fastByModel: {}, effortStamp: {}, fastStamp: {} };
    bySlot.set(k, slot);
  }
  return slot;
}

/** 写下一个值并返回这次写入的序号;值没变也换新序号(同值推送同样让更早的撤回失效)。 */
function setMirrorEffort(sessionId: string, agent: AgentKind, providerId: string, model: string, effort: string): number | undefined {
  if (!sessionId || !providerId || !model || !effort) return undefined;
  const slot = getSlot(sessionId, agent, providerId, true)!;
  const stamp = (slot.effortStamp[model] = ++stampSeq);
  if (slot.effortByModel[model] === effort) return stamp;
  slot.effortByModel[model] = effort;
  emit();
  return stamp;
}

function setMirrorFast(sessionId: string, agent: AgentKind, providerId: string, model: string, enabled: boolean | 'ultrafast'): number | undefined {
  if (!sessionId || !providerId || !model) return undefined;
  const slot = getSlot(sessionId, agent, providerId, true)!;
  const stamp = (slot.fastStamp[model] = ++stampSeq);
  if (slot.fastByModel[model] === enabled) return stamp;
  slot.fastByModel[model] = enabled;
  emit();
  return stamp;
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
  if ((typeof p.fast === 'boolean' || p.fast === 'ultrafast')) {
    setMirrorFast(p.sessionId, p.agent, p.providerId, p.model, p.fast);
  }
}

/** 清掉某会话的镜像(离开会话页时调,避免泄漏)。 */
export function clearSessionMirror(sessionId: string): void {
  if (store.delete(sessionId)) emit();
}

/**
 * 一次写穿的结果:被控端收下任一条请求即写到(两条写的是同一份预设,只支持其中一条的旧被控端
 * 照常算数);全部被拒 / 断连才算没写到——先撤回乐观值,再把失败交给等结果的调用方。
 * 不等结果的调用方(旧列表)不会留下未处理的拒绝。
 */
function settleWrite(
  requests: void | readonly Promise<unknown>[],
  undo: () => void,
): void | Promise<void> {
  if (!requests || requests.length === 0) return;
  const settled = new Promise<void>((resolve, reject) => {
    let failed = 0;
    for (const request of requests) {
      request.then(
        () => resolve(),
        (error) => {
          if (++failed < requests.length) return;
          undo();
          reject(error);
        },
      );
    }
  });
  settled.catch(() => undefined);
  return settled;
}

/**
 * 给模型选择列表注入的 accessors:读镜像、写镜像 + 经 onWrite 写穿被控端。
 * onWrite 由调用方绑定隧道调用(set-session-model-pref + apply-new-maker-draft-pref 双写),
 * 返回它发出的请求;本工厂负责「乐观写镜像 + 触发 onWrite + 没写到时撤回」,不关心传输细节。
 * 撤回只动自己写下的那一次:期间被控端推来的值(哪怕和乐观值相同——那是被控端已经有这个值的
 * 证据)、或之后的另一次写入保持不变。
 */
export function makeSessionMirrorAccessors(
  sessionId: string,
  onWrite: (
    agent: AgentKind,
    providerId: string,
    model: string,
    patch: { effort?: string; fast?: boolean | 'ultrafast' },
  ) => void | readonly Promise<unknown>[],
): MobileModelMemoryAccessors {
  return {
    getEffort: (agent, providerId, model) =>
      getSlot(sessionId, agent, providerId, false)?.effortByModel[model],
    getFast: (agent, providerId, model) =>
      getSlot(sessionId, agent, providerId, false)?.fastByModel[model],
    setEffort: (agent, providerId, model, effort) => {
      const previous = getSlot(sessionId, agent, providerId, false)?.effortByModel[model];
      const stamp = setMirrorEffort(sessionId, agent, providerId, model, effort);
      return settleWrite(onWrite(agent, providerId, model, { effort }), () => {
        const slot = getSlot(sessionId, agent, providerId, false);
        if (!slot || previous === effort || slot.effortStamp[model] !== stamp) return;
        if (previous === undefined) delete slot.effortByModel[model];
        else slot.effortByModel[model] = previous;
        emit();
      });
    },
    setFast: (agent, providerId, model, enabled) => {
      const previous = getSlot(sessionId, agent, providerId, false)?.fastByModel[model];
      const stamp = setMirrorFast(sessionId, agent, providerId, model, enabled);
      return settleWrite(onWrite(agent, providerId, model, { fast: enabled }), () => {
        const slot = getSlot(sessionId, agent, providerId, false);
        if (!slot || previous === enabled || slot.fastStamp[model] !== stamp) return;
        if (previous === undefined) delete slot.fastByModel[model];
        else slot.fastByModel[model] = previous;
        emit();
      });
    },
  };
}

/** 测试用 —— 清空整个进程内镜像(其它代码不应调用)。 */
export function __resetForTest(): void {
  store.clear();
  version = 0;
}
