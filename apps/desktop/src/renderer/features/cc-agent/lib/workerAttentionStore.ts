import { useSyncExternalStore } from 'react';

export type WorkerAttentionReason =
  { readonly kind: 'done' } | { readonly kind: 'permission'; readonly requestId: string };

export type WorkerAttentionSnapshot = ReadonlyMap<string, readonly WorkerAttentionReason[]>;

const listeners = new Set<() => void>();
const attentionByWorkerId = new Map<string, Map<string, WorkerAttentionReason>>();
let snapshot: WorkerAttentionSnapshot = new Map();

function reasonKey(reason: WorkerAttentionReason): string {
  return reason.kind === 'done' ? 'done' : `permission:${reason.requestId}`;
}

function emit(): void {
  snapshot = new Map(
    [...attentionByWorkerId].map(([workerId, reasons]) => [
      workerId,
      Object.freeze([...reasons.values()]),
    ]),
  );
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getWorkerAttentionSnapshot(): WorkerAttentionSnapshot {
  return snapshot;
}

export function useWorkerAttentionSnapshot(): WorkerAttentionSnapshot {
  return useSyncExternalStore(
    subscribe,
    getWorkerAttentionSnapshot,
    getWorkerAttentionSnapshot,
  );
}

export function hasWorkerAttention(workerId: string): boolean {
  return attentionByWorkerId.has(workerId);
}

export function markWorkerAttention(
  workerId: string,
  reason: WorkerAttentionReason = { kind: 'done' },
): void {
  let reasons = attentionByWorkerId.get(workerId);
  if (!reasons) {
    reasons = new Map();
    attentionByWorkerId.set(workerId, reasons);
  }
  const key = reasonKey(reason);
  if (reasons.has(key)) return;
  reasons.set(key, reason);
  emit();
}

/**
 * Clear one reason. The default intentionally acknowledges only unread done;
 * a pending permission is live state and must be cleared by its request id.
 */
export function clearWorkerAttention(
  workerId: string,
  reason: WorkerAttentionReason = { kind: 'done' },
): boolean {
  const reasons = attentionByWorkerId.get(workerId);
  if (!reasons || !reasons.delete(reasonKey(reason))) return false;
  if (reasons.size === 0) attentionByWorkerId.delete(workerId);
  emit();
  return true;
}

export function clearWorkerAttentionMany(workerIds: Iterable<string>): number {
  let changed = 0;
  for (const workerId of workerIds) {
    if (attentionByWorkerId.delete(workerId)) changed += 1;
  }
  if (changed > 0) emit();
  return changed;
}

export function __resetWorkerAttentionStoreForTest(): void {
  attentionByWorkerId.clear();
  snapshot = new Map();
  listeners.clear();
}

export function __getWorkerAttentionSnapshotForTest(): WorkerAttentionSnapshot {
  return getWorkerAttentionSnapshot();
}
