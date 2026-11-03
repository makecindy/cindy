import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { makerChatStore, type SessionStatusInfo } from '@/lib/makerChatStore';
import { isRemoteSessionSticky } from '@/lib/makerTransport';
import {
  getSessionAttentionKinds,
  subscribeSessionAttention,
  type AttentionKind,
} from '@/lib/sessionAttentionStore';
import type { WorkerInfo } from '../hooks/workerProjectionStore';

/** 只派生 Orca 展示：不写回任务提醒，也不触发系统通知。 */
export function resolveOrcaWorkerTaskAttention(
  kind: AttentionKind | undefined,
  status: SessionStatusInfo | undefined,
): 'error' | 'awaiting' | undefined {
  if (kind === 'error') return 'error';
  return kind === 'awaiting' || hasPendingWorkerInteraction(status) ? 'awaiting' : undefined;
}

function hasPendingWorkerInteraction(status: SessionStatusInfo | undefined): boolean {
  return Boolean(
    status?.hasPendingAskUser ||
    status?.hasPendingPermission ||
    status?.hasPendingPlanReview ||
    status?.hasPendingPluginSetup ||
    status?.hasPendingInputHandoff,
  );
}

/** 与本机任务提醒的可读范围一致；远程供应商不改变任务所在电脑。 */
export function isLocalOrcaWorkerTask(
  worker: Pick<WorkerInfo, 'sessionId' | 'executionDevice'>,
  leadSessionId?: string,
): boolean {
  return !worker.executionDevice &&
    !isRemoteSessionSticky(worker.sessionId) &&
    !(leadSessionId && isRemoteSessionSticky(leadSessionId));
}

export function localOrcaWorkerSessionIds(
  workers: readonly Pick<WorkerInfo, 'sessionId' | 'executionDevice'>[],
  leadSessionId?: string,
): string[] {
  return workers
    .filter((worker) => isLocalOrcaWorkerTask(worker, leadSessionId))
    .map((worker) => worker.sessionId);
}

/** 流式消息会频繁广播；只在 Worker 集合或其 pending 布尔值变化时通知消费方。 */
export function subscribeOrcaWorkerPendingInteractions(
  getSessionIds: () => readonly string[],
  listener: () => void,
): () => void {
  const getKey = () => {
    const statuses = makerChatStore.getRunningSnapshot();
    const ids = getSessionIds();
    // 投影可能在两次 chat 广播之间才加载；集合变化也要失效，避免漏掉新 Worker 的 pending 下降沿。
    return JSON.stringify([ids, ids.filter((id) => hasPendingWorkerInteraction(statuses.get(id)))]);
  };
  let previous = getKey();
  return makerChatStore.subscribeAll(() => {
    const next = getKey();
    if (next === previous) return;
    previous = next;
    listener();
  });
}

/** 同一组 Worker 只订阅一次，primitive 快照防止无关任务和输出内容使列表重渲染。 */
export function useOrcaWorkerTaskAttentionKinds(
  sessionIds: readonly string[],
): ReadonlyMap<string, 'error' | 'awaiting'> {
  const idsKey = JSON.stringify(sessionIds);
  const ids = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const offAttention = subscribeSessionAttention(listener);
      const offPending = subscribeOrcaWorkerPendingInteractions(() => ids, listener);
      return () => {
        offAttention();
        offPending();
      };
    },
    [ids],
  );
  const getSnapshot = () => {
    const attention = getSessionAttentionKinds();
    const statuses = makerChatStore.getRunningSnapshot();
    return JSON.stringify(
      ids.flatMap((id) => {
        const kind = resolveOrcaWorkerTaskAttention(attention.get(id), statuses.get(id));
        return kind ? [[id, kind]] : [];
      }),
    );
  };
  const key = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => new Map(JSON.parse(key) as [string, 'error' | 'awaiting'][]), [key]);
}
