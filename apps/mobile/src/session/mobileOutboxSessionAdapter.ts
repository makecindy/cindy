import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import type { DeviceLinkInvokeOptions } from '@/device-link/DeviceLinkContext';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { cindyMakeOutboxPolicy } from './cindyMakeOutboxPolicy';
import { isDurableOutboxHandedOff, isDurableOutboxSettled, type DurableOutboxRecord } from './durableOutbox';
import { sessionFromCreateResult } from './newSession';
import type { remoteSessionStore } from './remoteSessionStore';
import { outboxItemAttachments } from './sessionOutbox';
import type { RemoteSession } from './types';

type SessionSource = Pick<RemoteSession, 'id' | 'source' | 'deviceLinkDeviceId' | 'pendingLocalCreation'>;
type OutboxLease = ReturnType<typeof remoteSessionStore.acquireSessionMessageWork>;

const findOutboxSession = (record: DurableOutboxRecord, sessions: readonly SessionSource[]) =>
  sessions.find((session) => session.id === record.item.sessionId && session.deviceLinkDeviceId === record.deviceId);

export function outboxSessionIsHidden(record: DurableOutboxRecord, sessions: readonly SessionSource[]): boolean {
  return !CINDY_MAKE_ENABLED && isCindyMakeSource(findOutboxSession(record, sessions)?.source);
}

export function outboxSessionKey(record: DurableOutboxRecord): string {
  return JSON.stringify([record.deviceId, record.item.sessionId]);
}

/** Delivery follows the record's connection, including an independent official shared-task route. */
export function canConnectOutboxPeer(link: {
  status: string;
  getConnectionState?(deviceId: string): { status: string };
  getPresenceAvailability(deviceId: string): boolean | null;
}, deviceId: string): boolean {
  return (link.getConnectionState?.(deviceId).status ?? link.status) === 'online'
    && link.getPresenceAvailability(deviceId) !== false;
}

/** Accepted hidden sends stay durable without pinning their raw history window. */
export function outboxNeedsReconciliation(record: DurableOutboxRecord, isHistoryActive: boolean): boolean {
  return !isDurableOutboxHandedOff(record) || !!record.cancelRequested || isHistoryActive;
}

const OUTBOX_SESSION_HANDOFF_TTL_MS = 15_000;
const MAX_OUTBOX_SESSION_HANDOFFS = 32;

export interface OutboxSessionHandoffKey {
  accountKey: string;
  deviceId: string;
  sessionId: string;
  clientId: string;
  connectionEpoch: number;
}

export interface OutboxSessionHandoffEntry extends OutboxSessionHandoffKey {
  session: RemoteSession;
}

const handedOffOutboxSessions = new Map<string, { at: number; connectionEpoch: number; session: RemoteSession }>();

function outboxSessionHandoffMapKey(
  key: Pick<OutboxSessionHandoffKey, 'accountKey' | 'deviceId' | 'sessionId' | 'clientId'>,
): string {
  return JSON.stringify([key.accountKey, key.deviceId, key.sessionId, key.clientId]);
}

function pruneHandedOffOutboxSessions(now: number): void {
  for (const [key, entry] of handedOffOutboxSessions) {
    if (now - entry.at >= OUTBOX_SESSION_HANDOFF_TTL_MS || handedOffOutboxSessions.size > MAX_OUTBOX_SESSION_HANDOFFS) {
      handedOffOutboxSessions.delete(key);
    }
  }
}

/** Share the authoritative session row just read by new-session creation with the immediate outbox handoff. */
export function seedOutboxSessionHandoff(entry: OutboxSessionHandoffEntry, now = Date.now()): void {
  if (!entry.accountKey || !entry.deviceId || !entry.sessionId || !entry.clientId) return;
  if (entry.session.id !== entry.sessionId) return;
  const mapKey = outboxSessionHandoffMapKey(entry);
  handedOffOutboxSessions.delete(mapKey);
  handedOffOutboxSessions.set(mapKey, { at: now, connectionEpoch: entry.connectionEpoch, session: entry.session });
  pruneHandedOffOutboxSessions(now);
}

/** Peek the never-cleared boundary from a fresh creation handoff on the same connection epoch. */
export function peekOutboxSessionClearBoundary(
  query: OutboxSessionHandoffKey,
  now = Date.now(),
): null | undefined {
  const mapKey = outboxSessionHandoffMapKey(query);
  const entry = handedOffOutboxSessions.get(mapKey);
  if (!entry) return undefined;
  if (now - entry.at >= OUTBOX_SESSION_HANDOFF_TTL_MS || entry.connectionEpoch !== query.connectionEpoch) {
    handedOffOutboxSessions.delete(mapKey);
    return undefined;
  }
  return entry.session.clearedAt == null ? null : undefined;
}

/** Consume the handed-off session once so delivery skips a duplicate `local-db:sessions:get` round trip. */
export function takeOutboxSessionHandoff(
  query: OutboxSessionHandoffKey,
  now = Date.now(),
): RemoteSession | undefined {
  const mapKey = outboxSessionHandoffMapKey(query);
  const entry = handedOffOutboxSessions.get(mapKey);
  if (!entry) return undefined;
  handedOffOutboxSessions.delete(mapKey);
  if (now - entry.at >= OUTBOX_SESSION_HANDOFF_TTL_MS || entry.connectionEpoch !== query.connectionEpoch) {
    return undefined;
  }
  return entry.session.id === query.sessionId ? entry.session : undefined;
}

export function clearOutboxSessionHandoffs(): void {
  handedOffOutboxSessions.clear();
}

export interface OutboxSessionAccessDeps {
  getSessions(): readonly SessionSource[];
  getRecords(): readonly DurableOutboxRecord[];
  isCurrent(): boolean;
  guard(): void;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[] | undefined,
    options: DeviceLinkInvokeOptions & { preSend(): void },
  ): Promise<unknown>;
  readSession(record: DurableOutboxRecord): Promise<RemoteSession>;
  takeSeededSession?(record: DurableOutboxRecord): RemoteSession | undefined;
  isForeground(): boolean;
  canContinueInBackground?(record: DurableOutboxRecord): boolean;
  canConnect(deviceId: string): boolean;
  isCreationHeld(sessionId: string): boolean;
  hasCreationTask(sessionId: string): boolean;
  needsReconciliation(record: DurableOutboxRecord): boolean;
}

/** The bridge and tests use the same ownership, visibility and delivery decisions. */
export function createOutboxSessionAccess(deps: OutboxSessionAccessDeps) {
  const knownSession = (record: DurableOutboxRecord) => findOutboxSession(record, deps.getSessions());
  const hidden = (record: DurableOutboxRecord) => outboxSessionIsHidden(record, deps.getSessions());
  const invokeOwned =
    (record: DurableOutboxRecord, options?: DeviceLinkInvokeOptions): RemoteInvoke =>
    async (deviceId, channel, args) => {
      const guardRecord = () => {
        deps.guard();
        options?.preSend?.();
        if (deviceId !== record.deviceId) throw new Error('OUTBOX_DEVICE_CHANGED');
        if (!deps.getRecords().includes(record)) throw new Error('OUTBOX_STALE_WRITE');
        if (hidden(record)) throw new Error('OUTBOX_SESSION_DISABLED');
      };
      guardRecord();
      const result = await deps.invoke(deviceId, channel, args, {
        ...options,
        preSend: guardRecord,
      });
      guardRecord();
      return result as never;
    };
  // Existing per-attempt reuse: policy and preparation share one guarded read.
  const sessionReads = new Map<string, { at: number; read: Promise<RemoteSession> }>();
  const readSessionOnce = (record: DurableOutboxRecord): Promise<RemoteSession> => {
    const key = JSON.stringify([record.deviceId, record.item.sessionId, record.item.clientId]);
    const now = Date.now();
    for (const [other, entry] of sessionReads) if (now - entry.at >= 2_000) sessionReads.delete(other);
    const cached = sessionReads.get(key);
    if (cached) return cached.read;
    const seeded = deps.takeSeededSession?.(record);
    if (seeded && seeded.id === record.item.sessionId) {
      try {
        deps.guard();
        if (!deps.getRecords().includes(record)) throw new Error('OUTBOX_STALE_WRITE');
        if (hidden(record)) throw new Error('OUTBOX_SESSION_DISABLED');
      } catch (error) {
        return Promise.reject(error);
      }
      const read = Promise.resolve(seeded);
      sessionReads.set(key, { at: now, read });
      return read;
    }
    const read = deps.readSession(record);
    sessionReads.set(key, { at: now, read });
    read.catch(() => {
      if (sessionReads.get(key)?.read === read) sessionReads.delete(key);
    });
    return read;
  };
  const canRun = (record: DurableOutboxRecord) => {
    if (record.chat || !(deps.isForeground() || deps.canContinueInBackground?.(record) === true)) return false;
    const row = knownSession(record);
    return (!CINDY_MAKE_ENABLED && isCindyMakeSource(row?.source)) ||
      isDurableOutboxSettled(record) ||
      (!record.suspended &&
        !record.creation?.cancelled &&
        deps.needsReconciliation(record) &&
        !(row?.source === 'side-chat' && row.pendingLocalCreation) &&
        !deps.isCreationHeld(record.item.sessionId) &&
        deps.canConnect(record.deviceId) &&
        !deps.hasCreationTask(record.item.sessionId));
  };
  const sessionPolicy = (record: DurableOutboxRecord) =>
    cindyMakeOutboxPolicy(record, {
      knownSession: () => knownSession(record),
      readSession: () => readSessionOnce(record),
      isCurrent: () => deps.isCurrent() && deps.getRecords().includes(record),
    });
  return { hidden, invokeOwned, readSessionOnce, canRun, sessionPolicy };
}

export interface OutboxMessageLeaseDeps {
  isCurrent(): boolean;
  getRecords(): readonly DurableOutboxRecord[];
  hidden(record: DurableOutboxRecord): boolean;
  isCreationHeld?(sessionId: string): boolean;
  needsReconciliation(record: DurableOutboxRecord): boolean;
  restoreEditable(record: DurableOutboxRecord): boolean;
  dismissCancelled(record: { sessionId: string; deviceId: string }): void;
  store: Pick<typeof remoteSessionStore, 'getSessions' | 'upsertDeviceSession' | 'acquireSessionMessageWork'>;
}

/** Restore the existing creation projection and retain only message work still in use. */
export function createOutboxMessageLeases(deps: OutboxMessageLeaseDeps) {
  const leases = new Map<string, OutboxLease>();
  const refresh = () => {
    if (!deps.isCurrent()) return;
    const keys = new Set<string>();
    for (const record of deps.getRecords()) {
      if (record.chat) continue;
      if (isDurableOutboxSettled(record) || deps.hidden(record)) continue;
      if (deps.isCreationHeld?.(record.item.sessionId)) continue;
      if (deps.restoreEditable(record)) continue;
      if (record.creation?.cancelled) {
        deps.dismissCancelled({
          sessionId: record.item.sessionId,
          deviceId: record.deviceId,
        });
        continue;
      }
      if (record.creation && !deps.store.getSessions().some((session) => session.id === record.item.sessionId)) {
        deps.store.upsertDeviceSession(
          record.deviceId,
          record.creation.deviceName,
          sessionFromCreateResult(
            { sessionId: record.item.sessionId },
            {
              ...record.creation.draft,
              attachments: outboxItemAttachments(record.item),
            },
          ),
        );
      }
      if (!deps.needsReconciliation(record)) continue;
      const key = outboxSessionKey(record);
      keys.add(key);
      if (!leases.has(key)) leases.set(key, deps.store.acquireSessionMessageWork(record.item.sessionId, true));
    }
    for (const [key, lease] of leases)
      if (!keys.has(key)) {
        lease.release();
        leases.delete(key);
      }
  };
  const dispose = () => {
    for (const lease of leases.values()) lease.release();
  };
  return { leases, refresh, dispose };
}
