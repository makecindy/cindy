import { useSyncExternalStore } from 'react';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import {
  getPromptRecommendationPreference,
  PROMPT_RECOMMENDATION_KEY,
  subscribePromptRecommendationPreference,
  syncPromptRecommendationPreferenceFromStorageValue,
} from '@/hooks/usePromptRecommendationPreference';
import { makerChatStore } from '@/lib/makerChatStore';

/**
 * 输入框推荐提示词的 session 级运行期状态。
 *
 * 推荐只活在当前 renderer 生命周期，不落盘：全局监听记录本次运行期间真实发生的
 * running→stopped + lastTurnEndedAt，ChatInput 只在用户打开对应 session 时调用模型。
 * 这样后台完成不会漏，历史旧 session 也不会因一次普通打开凭空触发付费预测。
 */
export interface PromptRecommendationSnapshot {
  revision: number;
  phase: 'candidate' | 'predicting' | 'ready';
  prompt: string | null;
  requestSeq: number;
}

const COMPLETION_SETTLE_MS = 500;
const entries = new Map<string, PromptRecommendationSnapshot>();
const sessionListeners = new Map<string, Set<() => void>>();
const runningSessionIds = new Set<string>();
const sawRunningSessionIds = new Set<string>();
/** running 上升沿捕获的 agent startedAt，用于拒绝上一轮迟到的 ended patch。 */
const runStartedAtBySession = new Map<string, number>();
const pendingCompletionRevisions = new Map<string, number>();
const handledCompletionRevisions = new Map<string, number>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
let nextRequestSeq = 0;
let initialized = false;
let ownerKey: string | null = null;
const globalUnsubscribers: Array<() => void> = [];

function emitSession(sessionId: string): void {
  for (const listener of sessionListeners.get(sessionId) ?? []) listener();
}

function deleteEntry(sessionId: string): void {
  if (!entries.delete(sessionId)) return;
  emitSession(sessionId);
}

function clearSettleTimer(sessionId: string): void {
  const timer = settleTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  settleTimers.delete(sessionId);
}

function clearRuntimeState(): void {
  const changedSessionIds = [...entries.keys()];
  for (const timer of settleTimers.values()) clearTimeout(timer);
  entries.clear();
  runningSessionIds.clear();
  sawRunningSessionIds.clear();
  runStartedAtBySession.clear();
  pendingCompletionRevisions.clear();
  handledCompletionRevisions.clear();
  settleTimers.clear();
  for (const sessionId of changedSessionIds) emitSession(sessionId);
}

function handlePreferenceChanged(enabled: boolean): void {
  if (!enabled) {
    const changedSessionIds = [...entries.keys()];
    entries.clear();
    pendingCompletionRevisions.clear();
    sawRunningSessionIds.clear();
      runStartedAtBySession.clear();
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    for (const sessionId of changedSessionIds) emitSession(sessionId);
    return;
  }
  // 与前台原行为对齐：运行中打开开关，本轮正常结束后仍可产生推荐。
  for (const sessionId of runningSessionIds) {
    sawRunningSessionIds.add(sessionId);
    const startedAt = makerChatStore.getPromptRecommendationRunStartedAt(sessionId);
    if (startedAt != null) runStartedAtBySession.set(sessionId, startedAt);
  }
}

function scheduleCompletionSettle(sessionId: string): void {
  clearSettleTimer(sessionId);
  const timer = setTimeout(() => {
    settleTimers.delete(sessionId);
    settleCompletion(sessionId);
  }, COMPLETION_SETTLE_MS);
  settleTimers.set(sessionId, timer);
}

function settleCompletion(sessionId: string): void {
  if (runningSessionIds.has(sessionId)) return;
  const revision = pendingCompletionRevisions.get(sessionId);
  if (revision == null || !sawRunningSessionIds.has(sessionId)) return;

  pendingCompletionRevisions.delete(sessionId);
  sawRunningSessionIds.delete(sessionId);
  runStartedAtBySession.delete(sessionId);
  const previousHandled = handledCompletionRevisions.get(sessionId) ?? 0;
  if (revision <= previousHandled) return;
  handledCompletionRevisions.set(sessionId, revision);

  const status = makerChatStore.getPromptRecommendationCompletionStatus(sessionId);
  const eligible =
    getPromptRecommendationPreference() &&
    status != null &&
    !status.turnStoppedByUser &&
    !status.hasTerminalError &&
    !status.sideTask &&
    !status.hasBackgroundAgentWork &&
    !status.hasAutoDrainingQueue;

  if (!eligible) {
    deleteEntry(sessionId);
    return;
  }

  entries.set(sessionId, {
    revision,
    phase: 'candidate',
    prompt: null,
    requestSeq: 0,
  });
  emitSession(sessionId);
}

function applyRunningSnapshot(snapshot: ReadonlyMap<string, { isRunning: boolean }>): void {
  const nextRunning = new Set<string>();
  for (const [sessionId, info] of snapshot) {
    if (info.isRunning) nextRunning.add(sessionId);
  }

  for (const sessionId of nextRunning) {
    const startedAt = makerChatStore.getPromptRecommendationRunStartedAt(sessionId);
    if (runningSessionIds.has(sessionId)) {
      // wake bridge 会让聚合 running 在「主 turn → 后台任务 → wake turn」之间一直为 true，
      // 因而没有新的 false→true 边沿。仍需观察底层 agent startedAt 的换代，清掉主 turn
      // 的中间 ended revision，等待最终 wake turn 自己的 revision。
      if (startedAt != null) {
        const previousStartedAt = runStartedAtBySession.get(sessionId);
        const pendingRevision = pendingCompletionRevisions.get(sessionId);
        const underlyingTurnChanged =
          (previousStartedAt != null && previousStartedAt !== startedAt) ||
          (previousStartedAt == null && pendingRevision != null && pendingRevision <= startedAt);
        runStartedAtBySession.set(sessionId, startedAt);
        if (underlyingTurnChanged) {
          pendingCompletionRevisions.delete(sessionId);
          clearSettleTimer(sessionId);
          deleteEntry(sessionId);
        }
      }
      continue;
    }
    runningSessionIds.add(sessionId);
    sawRunningSessionIds.add(sessionId);
    if (startedAt != null) runStartedAtBySession.set(sessionId, startedAt);
    else runStartedAtBySession.delete(sessionId);
    // 新 turn 开始：旧完成 patch / 推荐 / 在途 renderer Promise 全部作废。
    pendingCompletionRevisions.delete(sessionId);
    clearSettleTimer(sessionId);
    deleteEntry(sessionId);
  }

  for (const sessionId of [...runningSessionIds]) {
    if (nextRunning.has(sessionId)) continue;
    runningSessionIds.delete(sessionId);
    scheduleCompletionSettle(sessionId);
  }
}

function noteTurnEnded(sessionId: string, revision: number): void {
  if (!Number.isFinite(revision) || revision <= 0) return;
  if (!sawRunningSessionIds.has(sessionId)) return;
  // 两条 push 通道没有顺序契约：上一轮 ended patch 可能在下一轮 running 后才到。
  // ended 时间不晚于本轮 startedAt 时必须忽略，不能把同毫秒的上一轮 patch
  // 配给下一轮 stopped 边沿。真实模型轮不会在启动同一毫秒内正常完成。
  const runStartedAt = runStartedAtBySession.get(sessionId);
  if (runStartedAt != null && revision <= runStartedAt) return;
  const handled = handledCompletionRevisions.get(sessionId) ?? 0;
  const pending = pendingCompletionRevisions.get(sessionId) ?? 0;
  if (revision <= handled || revision <= pending) return;
  pendingCompletionRevisions.set(sessionId, revision);
  scheduleCompletionSettle(sessionId);
}

/** App 级接线：必须在 ChatInput 之外常驻，才能记录后台 session 的完成。 */
export function initializePromptRecommendationStore(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  applyRunningSnapshot(makerChatStore.getRunningSnapshot());
  globalUnsubscribers.push(
    makerChatStore.subscribeAll(() => {
      applyRunningSnapshot(makerChatStore.getRunningSnapshot());
    }),
  );

  const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
  if (sessionsPush) {
    globalUnsubscribers.push(
      sessionsPush.onPatched(({ sessionId, patch }, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        if (patch.status === 'deleted') {
          clearPromptRecommendationSession(sessionId);
          return;
        }
        if (typeof patch.lastTurnEndedAt === 'number') {
          noteTurnEnded(sessionId, patch.lastTurnEndedAt);
        }
      }),
    );
  }

  globalUnsubscribers.push(subscribePromptRecommendationPreference(handlePreferenceChanged));
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PROMPT_RECOMMENDATION_KEY) return;
    // 先同步偏好模块的 memoryValue，再由 lifecycle subscription 清理 Store；
    // 否则首次挂载 ChatInput 的 render 仍可能读到旧 true 并发出付费请求。
    syncPromptRecommendationPreferenceFromStorageValue(event.newValue);
  };
  window.addEventListener('storage', onStorage);
  globalUnsubscribers.push(() => window.removeEventListener('storage', onStorage));
}

/** 认证 owner / 恢复代次切换时清空所有运行期推荐，防止跨账号复用。 */
export function setPromptRecommendationOwner(nextOwnerKey: string): void {
  if (ownerKey === nextOwnerKey) return;
  ownerKey = nextOwnerKey;
  clearRuntimeState();
}

function subscribeSession(sessionId: string | undefined, listener: () => void): () => void {
  if (!sessionId) return () => undefined;
  let listeners = sessionListeners.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    sessionListeners.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) sessionListeners.delete(sessionId);
  };
}

function getSessionSnapshot(
  sessionId: string | undefined,
): PromptRecommendationSnapshot | undefined {
  return sessionId ? entries.get(sessionId) : undefined;
}

/** 当前 session 的推荐状态；切换 session 时同步读取对应 key，不携带上一 session state。 */
export function usePromptRecommendation(
  sessionId: string | undefined,
): PromptRecommendationSnapshot | undefined {
  return useSyncExternalStore(
    (listener) => subscribeSession(sessionId, listener),
    () => getSessionSnapshot(sessionId),
    () => getSessionSnapshot(sessionId),
  );
}

/** candidate → predicting 的 compare-and-set；同 renderer 的分屏只允许一个请求。 */
export function beginPromptRecommendationPrediction(
  sessionId: string,
  revision: number,
): number | null {
  const current = entries.get(sessionId);
  if (!current || current.revision !== revision || current.phase !== 'candidate') return null;
  const requestSeq = ++nextRequestSeq;
  entries.set(sessionId, {
    ...current,
    phase: 'predicting',
    requestSeq,
  });
  emitSession(sessionId);
  return requestSeq;
}

/** 仅同 session + revision + requestSeq 的 Promise 可落地，旧轮结果静默丢弃。 */
export function resolvePromptRecommendationPrediction(
  sessionId: string,
  revision: number,
  requestSeq: number,
  prompt: string | null,
): void {
  const current = entries.get(sessionId);
  if (
    !current ||
    current.revision !== revision ||
    current.requestSeq !== requestSeq ||
    current.phase !== 'predicting'
  ) {
    return;
  }
  if (!prompt) {
    deleteEntry(sessionId);
    return;
  }
  entries.set(sessionId, {
    ...current,
    phase: 'ready',
    prompt,
  });
  emitSession(sessionId);
}

/** Tab / 发送 / workingDir / 附件等消费路径同步作废当前推荐。 */
export function dismissPromptRecommendation(sessionId: string, revision?: number): void {
  const current = entries.get(sessionId);
  if (!current || (revision != null && current.revision !== revision)) return;
  deleteEntry(sessionId);
}

export function clearPromptRecommendationSession(sessionId: string): void {
  clearSettleTimer(sessionId);
  runningSessionIds.delete(sessionId);
  sawRunningSessionIds.delete(sessionId);
  runStartedAtBySession.delete(sessionId);
  pendingCompletionRevisions.delete(sessionId);
  handledCompletionRevisions.delete(sessionId);
  deleteEntry(sessionId);
}

export const __testing = {
  applyRunningSnapshot,
  noteTurnEnded,
  settleCompletion,
  getSessionSnapshot,
  reset(): void {
    for (const unsubscribe of globalUnsubscribers.splice(0)) unsubscribe();
    initialized = false;
    ownerKey = null;
    nextRequestSeq = 0;
    clearRuntimeState();
    sessionListeners.clear();
  },
};
