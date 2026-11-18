import { useEffect, useMemo, useRef } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import type { OrcaWorkerStatus } from '../../../../shared/orca-worker-status';
import {
  getWorkerProjectionSnapshot,
  useWorkerProjectionOwners,
  useWorkerProjectionVersion,
} from './workerProjectionStore';
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
  const toPrune: string[] = [];

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

  for (const workerId of prevStatusByWorkerId.keys()) {
    if (!currentWorkerIds.has(workerId)) toPrune.push(workerId);
  }

  return { toMark, toPrune, nextStatusByWorkerId };
}

export function useOrcaWorkerAttentionByLeadIds(
  rawLeadSessionIds: readonly string[],
  activeSessionId: string | undefined,
): void {
  const leadSessionKey = [...new Set(rawLeadSessionIds)].join('\0');
  const leadSessionIds = useMemo(
    () => (leadSessionKey ? leadSessionKey.split('\0') : []),
    [leadSessionKey],
  );
  useWorkerProjectionOwners(leadSessionIds);
  const projectionVersion = useWorkerProjectionVersion();
  const prevStatusByWorkerIdRef = useRef<Map<string, OrcaWorkerStatus>>(new Map());

  useEffect(() => {
    if (leadSessionIds.length === 0) {
      clearWorkerAttentionMany(prevStatusByWorkerIdRef.current.keys());
      prevStatusByWorkerIdRef.current = new Map();
      return;
    }

    const currentWorkers = leadSessionIds
      .flatMap((leadSessionId) =>
        getWorkerProjectionSnapshot(leadSessionId).workers.map((worker): WorkerAttentionRecord => ({
          workerId: worker.workerId,
          leadSessionId,
          status: worker.status,
          focused: worker.focused,
        })),
      );
    const updates = computeWorkerAttentionUpdates(
      prevStatusByWorkerIdRef.current,
      currentWorkers,
      activeSessionId,
    );
    for (const workerId of updates.toMark) markWorkerAttention(workerId);
    clearWorkerAttentionMany(updates.toPrune);
    prevStatusByWorkerIdRef.current = updates.nextStatusByWorkerId;
  }, [activeSessionId, leadSessionKey, projectionVersion]);
}

export function useOrcaWorkerAttentionWatcher(
  sessions: readonly Session[],
  activeSessionId: string | undefined,
): void {
  const leadSessionIds = useMemo(
    () => sessions.filter(isOrcaLeadSession).map((session) => session.id),
    [sessions],
  );
  useOrcaWorkerAttentionByLeadIds(leadSessionIds, activeSessionId);
}
