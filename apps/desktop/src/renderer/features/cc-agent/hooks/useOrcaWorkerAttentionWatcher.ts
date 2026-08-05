import { useEffect, useMemo, useRef } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import type { OrcaWorkerStatus } from '../../../../shared/orca-worker-status';
import {
  clearWorkerAttentionMany,
  markWorkerAttention,
} from '../lib/workerAttentionStore';

export interface WorkerAttentionRecord {
  workerId: string;
  leadSessionId: string;
  status: OrcaWorkerStatus;
  focused: boolean;
}

export interface WorkerAttentionUpdates {
  toMark: string[];
  toPrune: string[];
  nextStatusByWorkerId: Map<string, OrcaWorkerStatus>;
}

export function computeWorkerAttentionUpdates(
  prevStatusByWorkerId: ReadonlyMap<string, OrcaWorkerStatus>,
  currentWorkers: readonly WorkerAttentionRecord[],
  activeSessionId: string | undefined,
): WorkerAttentionUpdates {
  const currentWorkerIds = new Set<string>();
  const nextStatusByWorkerId = new Map<string, OrcaWorkerStatus>();
  const toMark: string[] = [];

  for (const worker of currentWorkers) {
    currentWorkerIds.add(worker.workerId);
    nextStatusByWorkerId.set(worker.workerId, worker.status);

    const prevStatus = prevStatusByWorkerId.get(worker.workerId);
    // `done` persists until the result is viewed and acknowledged, so an initial
    // snapshot can safely restore unread attention after a late mount or reload.
    const enteredDone = prevStatus !== 'done' && worker.status === 'done';
    const isViewed = worker.focused && worker.leadSessionId === activeSessionId;
    if (enteredDone && !isViewed) {
      toMark.push(worker.workerId);
    }
  }

  const toPrune: string[] = [];
  for (const workerId of prevStatusByWorkerId.keys()) {
    if (!currentWorkerIds.has(workerId)) toPrune.push(workerId);
  }

  return { toMark, toPrune, nextStatusByWorkerId };
}

function toWorkerAttentionRecord(raw: unknown): WorkerAttentionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const workerId = item.id;
  const leadSessionId = item.leadSessionId;
  const status = item.status;
  if (
    typeof workerId !== 'string' ||
    typeof leadSessionId !== 'string' ||
    (status !== 'idle' && status !== 'running' && status !== 'done' && status !== 'error')
  ) {
    return null;
  }
  return {
    workerId,
    leadSessionId,
    status,
    focused: item.focused === true,
  };
}

export function useOrcaWorkerAttentionWatcher(
  sessions: readonly Session[],
  activeSessionId: string | undefined,
): void {
  const leadSessionIds = useMemo(
    () => sessions.filter(isOrcaLeadSession).map((s) => s.id),
    [sessions],
  );
  const leadSessionKey = useMemo(
    () => leadSessionIds.join('\0'),
    [leadSessionIds],
  );
  const prevStatusByWorkerIdRef = useRef<Map<string, OrcaWorkerStatus>>(new Map());
  const refreshGenerationRef = useRef(0);
  const appliedRefreshGenerationRef = useRef(0);

  useEffect(() => {
    if (leadSessionIds.length === 0) {
      clearWorkerAttentionMany(prevStatusByWorkerIdRef.current.keys());
      prevStatusByWorkerIdRef.current = new Map();
      return;
    }

    let cancelled = false;
    const leadSessionIdSet = new Set(leadSessionIds);
    const refresh = () => {
      const generation = ++refreshGenerationRef.current;
      void Promise.all(
        leadSessionIds.map(async (leadSessionId) => {
          const workers = await window.electronAPI.localDb.orcaWorkflows
            .listWorkersByLead(leadSessionId)
            .catch(() => []);
          return workers;
        }),
      ).then((entries) => {
        if (cancelled || generation < appliedRefreshGenerationRef.current) return;
        const currentWorkers = entries
          .flat()
          .map(toWorkerAttentionRecord)
          .filter((worker): worker is WorkerAttentionRecord => worker !== null);
        const updates = computeWorkerAttentionUpdates(
          prevStatusByWorkerIdRef.current,
          currentWorkers,
          activeSessionId,
        );
        for (const workerId of updates.toMark) markWorkerAttention(workerId);
        clearWorkerAttentionMany(updates.toPrune);
        prevStatusByWorkerIdRef.current = updates.nextStatusByWorkerId;
        appliedRefreshGenerationRef.current = generation;
      });
    };
    refresh();

    const unsubscribe = window.electronAPI.localDb.orcaWorkflows.onOrcaWorkerChanged?.(
      (payload: unknown) => {
        const p = payload as { leadSessionId?: unknown };
        if (typeof p.leadSessionId === 'string' && leadSessionIdSet.has(p.leadSessionId)) {
          refresh();
        }
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [activeSessionId, leadSessionKey]);
}
