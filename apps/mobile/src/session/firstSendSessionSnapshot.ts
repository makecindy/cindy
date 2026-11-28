import { isDurableOutboxUnsent, type createDurableOutbox, type DurableOutboxRecord } from './durableOutbox';
import type { QueuedRemoteMessage, RemoteSession } from './types';
import { EMPTY_INPUT_PROJECTION } from './inputProjection';
import type { DeliveryProjection } from './durableOutboxDelivery';

export interface FirstSendInputDelivery {
  inputDeliveryVersion: 1;
  clearBoundaryMs: number | null;
}

export interface FirstSendSessionSnapshot {
  session: RemoteSession;
  connectionEpoch: number;
  inputDelivery?: FirstSendInputDelivery;
}

// A retry, edit, owner change, or cold recovery cannot reuse a replaced record.
const snapshots = new WeakMap<DurableOutboxRecord, FirstSendSessionSnapshot & { handedOffAt: number }>();
const MAX_AGE_MS = 5_000;

/** Save the creation fence with the message so a stale-cache retry cannot cross a clear. */
export async function handoffFirstSendSession(
  store: Pick<ReturnType<typeof createDurableOutbox>, 'update'>,
  record: DurableOutboxRecord,
  template: QueuedRemoteMessage,
  snapshot: FirstSendSessionSnapshot | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) throw new Error('OUTBOX_OWNER_CHANGED');
  const queued = await store.update(record, {
    ...(record.creation?.needsHostCreation ? { creation: { ...record.creation, needsHostCreation: undefined } } : {}),
    template, state: 'queued', suspended: false, error: undefined,
    ...(record.clearBoundaryMs === undefined && snapshot?.inputDelivery
      ? { clearBoundaryMs: snapshot.inputDelivery.clearBoundaryMs } : {}),
  });
  // The creation task holds delivery until its handoff returns.
  if (snapshot && isCurrent()) rememberFirstSendSession(queued, snapshot);
}

export function rememberFirstSendSession(record: DurableOutboxRecord, snapshot: FirstSendSessionSnapshot): void {
  const { session } = snapshot;
  if (record.creation && record.state === 'queued' && !record.prepared && !record.cancelRequested
    && !record.resourceRef && isDurableOutboxUnsent(record)
    && record.uploads.length === 0 && record.item.attachmentSlots.length === 0 && record.item.sessionId === session.id
    && session.workspaceKind === 'dialogue' && session.status === 'active' && session.workingDir) {
    snapshots.set(record, { ...snapshot, handedOffAt: Date.now() });
  }
}

function readSnapshot(record: DurableOutboxRecord, connectionEpoch: number): FirstSendSessionSnapshot | undefined {
  const snapshot = snapshots.get(record);
  if (!snapshot) return undefined;
  const age = Date.now() - snapshot.handedOffAt;
  return snapshot.connectionEpoch === connectionEpoch && age >= 0 && age < MAX_AGE_MS
    ? snapshot : undefined;
}

export function readFirstSendSession(record: DurableOutboxRecord, connectionEpoch: number): RemoteSession | undefined {
  return readSnapshot(record, connectionEpoch)?.session;
}

/** Only a never-sent record can use creation metadata instead of receipt reconciliation. */
export function readFirstSendProjection(record: DurableOutboxRecord, connectionEpoch: number): DeliveryProjection | undefined {
  const inputDelivery = readSnapshot(record, connectionEpoch)?.inputDelivery;
  return inputDelivery ? {
    ...EMPTY_INPUT_PROJECTION,
    sessionId: record.item.sessionId,
    ...inputDelivery,
  } : undefined;
}
