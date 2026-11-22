import { isDurableOutboxUnsent, type DurableOutboxRecord } from './durableOutbox';
import type { RemoteSession } from './types';

export interface FirstSendSessionSnapshot {
  session: RemoteSession;
  connectionEpoch: number;
  createdAt: number;
}

// A retry, edit, owner change, or cold recovery cannot reuse a replaced record.
const snapshots = new WeakMap<DurableOutboxRecord, FirstSendSessionSnapshot>();
const MAX_AGE_MS = 5_000;

export function rememberFirstSendSession(record: DurableOutboxRecord, snapshot: FirstSendSessionSnapshot): void {
  const { session } = snapshot;
  if (record.creation && record.state === 'queued' && !record.prepared && !record.cancelRequested
    && !record.resourceRef && isDurableOutboxUnsent(record)
    && record.uploads.length === 0 && record.item.attachmentSlots.length === 0 && record.item.sessionId === session.id
    && session.workspaceKind === 'dialogue' && session.status === 'active' && session.workingDir) {
    snapshots.set(record, snapshot);
  }
}

export function readFirstSendSession(record: DurableOutboxRecord, connectionEpoch: number): RemoteSession | undefined {
  const snapshot = snapshots.get(record);
  if (!snapshot) return undefined;
  const age = Date.now() - snapshot.createdAt;
  return snapshot.connectionEpoch === connectionEpoch && age >= 0 && age < MAX_AGE_MS
    ? snapshot.session : undefined;
}
