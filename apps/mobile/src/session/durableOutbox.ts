import type { AnnotationRegion } from "@cindy/maker-shared/image-annotation";
import type { NewSessionDraft } from "./newSession";
import type { ComposerDocument } from './composerDocument';
import type { MobileOutboxItem } from "./sessionOutbox";
import type { QueuedRemoteMessage, RemoteSerializedAttachment } from "./types";

export interface DurableUpload {
  slot: number;
  fileName: string;
  name: string;
  mimeType?: string;
  kind: "image" | "file";
  size: number;
  annotated?: boolean;
  /** 标注区域(可选,见 RemoteSerializedAttachment.annotationRegions)。 */
  annotationRegions?: AnnotationRegion[];
}

export interface DurableOutboxRecord {
  version: 1;
  /** Canonical realm-qualified auth accountKey; unqualified pre-release rows are never claimed. */
  accountId: string;
  deviceId: string;
  /** Stable disk/file identity when a cancelled creation is retried with a fresh session ID. */
  storageSessionId?: string;
  item: MobileOutboxItem;
  createdAt: number;
  state: "queued" | "sending" | "confirming" | "host-owned" | "failed";
  uploads: DurableUpload[];
  prepared?: QueuedRemoteMessage;
  /** Persisted before enqueue; absent on older records means unknown, not unsent. */
  enqueueStarted?: boolean;
  draftHandoff?: { before: ComposerDocument; after: ComposerDocument };
  clearBoundaryMs?: number | null;
  /** Only hosts advertising durable delivery may receive an uncertain retry. */
  retrySafe?: boolean;
  error?: string;
  cancelRequested?: boolean;
  /** Delivery is settled; retain the ledger solely until local cleanup succeeds. */
  cleanupOutcome?: "accepted" | "cancelled";
  sendAtMs?: number;
  suspended?: boolean;
  template?: QueuedRemoteMessage;
  refreshUploads?: boolean;
  creation?: {
    draft: NewSessionDraft;
    originalWorkingDir?: string;
    cancelled?: true;
    deviceName: string;
    planModeArm: boolean;
    restorePermissionMode: string | null;
  };
}

export interface OutboxStorage {
  getAllKeys(): Promise<readonly string[]>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function isDurableOutboxSettled(record: DurableOutboxRecord): boolean {
  return record.cleanupOutcome !== undefined;
}

/**
 * 已移交被控端的记录:持久投递已收下(或已落定)。会话 FIFO 只派发第一条未移交的记录,
 * 移交后的记录只做对账,不再挡后面的消息。
 */
export function isDurableOutboxHandedOff(record: Pick<DurableOutboxRecord, 'state' | 'retrySafe' | 'cleanupOutcome'>): boolean {
  return (record.state === "host-owned" && record.retrySafe === true) || record.cleanupOutcome !== undefined;
}

/** Preparation is local; only a persisted pre-enqueue proof permits offline disposal.
 * Legacy records without that proof must also lack all previous-send evidence.
 */
export function isDurableOutboxUnsent(record: DurableOutboxRecord): boolean {
  return record.enqueueStarted === false || (record.enqueueStarted === undefined
    && !record.prepared && record.sendAtMs === undefined);
}

export const DURABLE_OUTBOX_PREFIX = "cindy.mobile.outbox.v1.";
const PREFIX = DURABLE_OUTBOX_PREFIX;
const EMPTY: readonly DurableOutboxRecord[] = Object.freeze([]);
const keyFor = (
  r: Pick<DurableOutboxRecord, "accountId" | "deviceId" | "item" | "storageSessionId">,
) =>
  PREFIX +
  [r.accountId, r.deviceId, r.storageSessionId ?? r.item.sessionId, r.item.clientId]
    .map(encodeURIComponent)
    .join("/");

/** Write-through message ownership. Views are published only after the durable write succeeds. */
export function createDurableOutbox(storage: OutboxStorage, reconcileDraft?: (
  record: DurableOutboxRecord, guard: () => void,
) => Promise<void>) {
  let accountId = "";
  let generation = 0;
  let records: readonly DurableOutboxRecord[] = EMPTY;
  let writes: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> = Promise.resolve();
  let activationFailed = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const result = writes.then(op);
    writes = result.catch(() => undefined);
    return result;
  };
  const assertOwner = (owner: string, epoch: number) => {
    if (!owner || owner !== accountId || epoch !== generation)
      throw new Error("OUTBOX_OWNER_CHANGED");
  };
  const mutate = async (
    record: DurableOutboxRecord,
    next: DurableOutboxRecord | null,
    adding = false,
  ): Promise<DurableOutboxRecord | null> => {
    const epoch = generation;
    await store.ready();
    return serialize(async () => {
      assertOwner(record.accountId, epoch);
      const current = records.find((r) => keyFor(r) === keyFor(record));
      if (adding ? current !== undefined : current !== record)
        throw new Error("OUTBOX_STALE_WRITE");
      if (next && keyFor(next) !== keyFor(record)) throw new Error("OUTBOX_IDENTITY_CHANGED");
      if (next && next.item.sessionId !== record.item.sessionId
        && (!record.creation?.cancelled || !next.creation || record.prepared)) {
        throw new Error('OUTBOX_CREATION_OWNERSHIP_UNRESOLVED');
      }
      if (next) await storage.setItem(keyFor(record), JSON.stringify(next));
      else await storage.removeItem(keyFor(record));
      // The disk write is already committed, even if logout raced its completion.
      // Report success to the old caller so it does not delete files now owned by that ledger.
      if (record.accountId !== accountId || epoch !== generation) return next;
      records = next
        ? [...records.filter((r) => keyFor(r) !== keyFor(record)), next].sort(
            (a, b) => a.createdAt - b.createdAt,
          )
        : records.filter((r) => keyFor(r) !== keyFor(record));
      emit();
      return next;
    });
  };
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => records,
    getAccountId: () => accountId,
    async reconcileDrafts(sessionId?: string): Promise<void> {
      const owner = accountId;
      const epoch = generation;
      await store.ready();
      if (!reconcileDraft) return;
      await serialize(async () => {
        const guard = () => assertOwner(owner, epoch);
        guard();
        for (const record of records) {
          if (!record.draftHandoff || (sessionId !== undefined && record.item.sessionId !== sessionId)) continue;
          await reconcileDraft(record, guard);
          guard();
          const next = { ...record, draftHandoff: undefined };
          await storage.setItem(keyFor(record), JSON.stringify(next));
          guard();
          records = records.map((r) => r === record ? next : r);
          emit();
        }
      });
    },
    activate(owner: string): Promise<void> {
      if (owner === accountId && !activationFailed) return ready;
      accountId = owner;
      const epoch = ++generation;
      activationFailed = false;
      records = EMPTY;
      emit();
      ready = serialize(async () => {
        if (!owner) return;
        const keys = (await storage.getAllKeys()).filter((key) =>
          key.startsWith(PREFIX + encodeURIComponent(owner) + "/"),
        );
        const loaded: DurableOutboxRecord[] = [];
        for (const key of keys) {
          const raw = await storage.getItem(key);
          if (!raw) continue;
          // One corrupt row must not fail the whole ledger. On Android that threw
          // during every session's draft hydration, and send() returns immediately
          // while composerDraftHydrated stays false. Leave the bytes in place.
          let record: unknown;
          try {
            record = JSON.parse(raw);
          } catch {
            continue;
          }
          if (!isLoadableOutboxRecord(record, owner, key)) {
            console.warn('[outbox] skipped unreadable ledger row', key);
            continue;
          }
          loaded.push(record);
        }
        assertOwner(owner, epoch);
        records = loaded.sort((a, b) => a.createdAt - b.createdAt);
        emit();
      }).catch((error: unknown) => {
        if (owner === accountId && epoch === generation) activationFailed = true;
        throw error;
      });
      return ready;
    },
    async add(record: DurableOutboxRecord) {
      if (!record.accountId || !record.deviceId)
        throw new Error("OUTBOX_OWNER_REQUIRED");
      await store.ready();
      if (records.some((r) => keyFor(r) === keyFor(record)))
        throw new Error("OUTBOX_DUPLICATE_ID");
      await mutate(record, record, true);
    },
    update: (
      record: DurableOutboxRecord,
      patch: Partial<DurableOutboxRecord>,
    ) =>
      mutate(record, {
        ...record,
        ...patch,
        accountId: record.accountId,
        deviceId: record.deviceId,
      }) as Promise<DurableOutboxRecord>,
    remove: (record: DurableOutboxRecord) => mutate(record, null),
    ready: (): Promise<void> => store.activate(accountId),
  };
  return store;
}

function isLoadableOutboxRecord(
  record: unknown,
  owner: string,
  key: string,
): record is DurableOutboxRecord {
  if (!record || typeof record !== 'object') return false;
  const row = record as DurableOutboxRecord;
  return row.version === 1
    && row.accountId === owner
    && !!row.deviceId
    && !!row.item?.sessionId
    && !!row.item.clientId
    && (row.storageSessionId === undefined
      || (typeof row.storageSessionId === 'string' && row.storageSessionId.length > 0))
    && keyFor(row) === key
    && Array.isArray(row.uploads)
    && (row.cleanupOutcome === undefined
      || row.cleanupOutcome === 'accepted'
      || row.cleanupOutcome === 'cancelled')
    && ["queued", "sending", "confirming", "host-owned", "failed"].includes(row.state)
    && Number.isFinite(row.createdAt)
    && Array.isArray(row.item.attachmentSlots);
}

export type DurableOutboxStore = ReturnType<typeof createDurableOutbox>;

/** Synchronous page observer: reserve a transcript slot before the sender's await resumes. */
export function observeDurableOutboxSending(
  store: DurableOutboxStore,
  deviceId: string,
  sessionId: string,
  onSending: (record: DurableOutboxRecord) => void,
  onSettled: (clientId: string) => void,
  accountId = store.getAccountId(),
): () => void {
  const scoped = () => store.getSnapshot().filter((r) => !isDurableOutboxSettled(r) && r.accountId === accountId
    && r.deviceId === deviceId && r.item.sessionId === sessionId);
  let previous = new Map(scoped().map((r) => [r.item.clientId, r]));
  const seen = new Set([...previous.values()].filter((r) => r.sendAtMs !== undefined
    || r.state !== 'queued').map((r) => r.item.clientId));
  return store.subscribe(() => {
    const next = new Map(scoped().map((r) => [r.item.clientId, r]));
    for (const [id, record] of next) {
      if (record.state === 'sending' && record.prepared && !seen.has(id)
        && previous.get(id)?.state === 'queued') {
        seen.add(id);
        onSending(record);
      }
    }
    for (const [id, record] of previous) {
      if (record.state === 'sending' && next.get(id)?.state !== 'sending') onSettled(id);
    }
    previous = next;
  });
}

/** Fill a durable upload slot without changing the message ID or attachment ordering. */
export function withDurableUpload(
  record: DurableOutboxRecord,
  slot: number,
  attachment: RemoteSerializedAttachment,
): MobileOutboxItem {
  return {
    ...record.item,
    attachmentSlots: record.item.attachmentSlots.map((existing, index) =>
      index === slot ? attachment : existing,
    ),
    waitingIds: record.item.waitingIds.filter(
      (id) => record.item.slotByLocalId[id] !== slot,
    ),
    failedIds: record.item.failedIds.filter(
      (id) => record.item.slotByLocalId[id] !== slot,
    ),
  };
}
