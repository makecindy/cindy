/**
 * useWorkers — 读取 renderer 进程内唯一的 Orca worker 投影。
 */

import { useCallback } from 'react';

import {
  clearWorkerProjectionStore,
  getActiveWorkerCount,
  refreshWorkerCreationState,
  revalidateWorkersProjection,
  useWorkerProjection,
  useWorkerProjectionOwner,
  type WorkerCreationRefreshResult,
  type WorkersRefreshResult,
} from './workerProjectionStore';

export type {
  WorkerCreationRefreshResult,
  WorkerInfo,
  WorkersRefreshResult,
} from './workerProjectionStore';

export function clearWorkersCache(leadSessionId?: string): void {
  clearWorkerProjectionStore(leadSessionId);
}

export function useWorkers(leadSessionId: string | undefined) {
  useWorkerProjectionOwner(leadSessionId);
  const snapshot = useWorkerProjection(leadSessionId);

  const refresh = useCallback(async (): Promise<WorkersRefreshResult | null> => {
    if (!leadSessionId) return null;
    return revalidateWorkersProjection(leadSessionId);
  }, [leadSessionId]);

  const refreshCreationState = useCallback(async (): Promise<WorkerCreationRefreshResult> => {
    if (!leadSessionId) return { status: 'failed', workers: [], hardLimit: null };
    return refreshWorkerCreationState(leadSessionId);
  }, [leadSessionId]);

  const { workers, softLimit, hardLimit } = snapshot;
  const focusedWorker = workers.find((w) => w.focused) ?? workers[0] ?? null;
  const activeWorkerCount = getActiveWorkerCount(workers);

  return {
    workers,
    focusedWorker,
    activeWorkerCount,
    softLimit,
    hardLimit,
    refresh,
    refreshCreationState,
  };
}
