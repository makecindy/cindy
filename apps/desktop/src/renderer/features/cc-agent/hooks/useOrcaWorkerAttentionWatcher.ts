import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { Session } from '@/lib/ccAgent.types';
import { makerChatStore } from '@/lib/makerChatStore';
import { isOrcaLeadSession } from '@/lib/orcaSessionIdentity';
import type { OrcaWorkerStatus } from '../../../../shared/orca-worker-status';
import {
  getWorkerProjectionSnapshot,
  useWorkerProjectionOwners,
  useWorkerProjectionVersion,
} from './workerProjectionStore';
import {
  clearWorkerAttention,
  clearWorkerAttentionMany,
  markWorkerAttention,
  type WorkerAttentionReason,
} from '../lib/workerAttentionStore';

export interface WorkerAttentionRecord {
  workerId: string;
  leadSessionId: string;
  status: OrcaWorkerStatus;
  focused: boolean;
  pendingPermissionRequestIds: readonly string[];
}

export interface WorkerAttentionObservedState {
  status: OrcaWorkerStatus;
  pendingPermissionRequestIds: readonly string[];
}

export interface WorkerAttentionMutation {
  workerId: string;
  reason: WorkerAttentionReason;
}

export interface WorkerAttentionUpdates {
  toMark: WorkerAttentionMutation[];
  toClear: WorkerAttentionMutation[];
  toPrune: string[];
  nextStateByWorkerId: Map<string, WorkerAttentionObservedState>;
}

export function computeWorkerAttentionUpdates(
  prevStateByWorkerId: ReadonlyMap<string, WorkerAttentionObservedState>,
  currentWorkers: readonly WorkerAttentionRecord[],
  activeSessionId: string | undefined,
): WorkerAttentionUpdates {
  const currentWorkerIds = new Set<string>();
  const nextStateByWorkerId = new Map<string, WorkerAttentionObservedState>();
  const toMark: WorkerAttentionMutation[] = [];
  const toClear: WorkerAttentionMutation[] = [];
  const toPrune: string[] = [];

  for (const worker of currentWorkers) {
    currentWorkerIds.add(worker.workerId);
    nextStateByWorkerId.set(worker.workerId, {
      status: worker.status,
      pendingPermissionRequestIds: worker.pendingPermissionRequestIds,
    });

    const prevState = prevStateByWorkerId.get(worker.workerId);
    // `done` persists until the result is viewed and acknowledged, so an initial
    // snapshot can safely restore unread attention after a late mount or reload.
    const enteredDone = prevState?.status !== 'done' && worker.status === 'done';
    const isViewed = worker.focused && worker.leadSessionId === activeSessionId;
    if (enteredDone && !isViewed) {
      toMark.push({ workerId: worker.workerId, reason: { kind: 'done' } });
    }

    const previousRequestIds = new Set(prevState?.pendingPermissionRequestIds ?? []);
    const currentRequestIds = new Set(worker.pendingPermissionRequestIds);
    for (const previousRequestId of previousRequestIds) {
      if (!currentRequestIds.has(previousRequestId)) {
        toClear.push({
          workerId: worker.workerId,
          reason: { kind: 'permission', requestId: previousRequestId },
        });
      }
    }
    for (const currentRequestId of currentRequestIds) {
      if (!previousRequestIds.has(currentRequestId)) {
        // Permission is live blocking state rather than unread state. Keep it
        // projected even while focused; the selected Worker hides its own dot,
        // and navigating away restores the signal until this request resolves.
        toMark.push({
          workerId: worker.workerId,
          reason: { kind: 'permission', requestId: currentRequestId },
        });
      }
    }
  }

  for (const workerId of prevStateByWorkerId.keys()) {
    if (!currentWorkerIds.has(workerId)) toPrune.push(workerId);
  }

  return { toMark, toClear, toPrune, nextStateByWorkerId };
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
  const sessionStatusSnapshot = useSyncExternalStore(
    makerChatStore.subscribeAll,
    makerChatStore.getRunningSnapshot,
    makerChatStore.getRunningSnapshot,
  );
  const prevStateByWorkerIdRef = useRef<Map<string, WorkerAttentionObservedState>>(new Map());

  useEffect(() => {
    if (leadSessionIds.length === 0) {
      clearWorkerAttentionMany(prevStateByWorkerIdRef.current.keys());
      prevStateByWorkerIdRef.current = new Map();
      return;
    }

    const currentWorkers = leadSessionIds
      .flatMap((leadSessionId) =>
        getWorkerProjectionSnapshot(leadSessionId).workers.map((worker): WorkerAttentionRecord => ({
          workerId: worker.workerId,
          leadSessionId,
          status: worker.status,
          focused: worker.focused,
          pendingPermissionRequestIds:
            sessionStatusSnapshot.get(worker.sessionId)?.pendingPermissionRequestIds ?? [],
        })),
      );
    const updates = computeWorkerAttentionUpdates(
      prevStateByWorkerIdRef.current,
      currentWorkers,
      activeSessionId,
    );
    for (const update of updates.toClear) {
      clearWorkerAttention(update.workerId, update.reason);
    }
    for (const update of updates.toMark) {
      markWorkerAttention(update.workerId, update.reason);
    }
    clearWorkerAttentionMany(updates.toPrune);
    prevStateByWorkerIdRef.current = updates.nextStateByWorkerId;
  }, [activeSessionId, leadSessionKey, projectionVersion, sessionStatusSnapshot]);
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
