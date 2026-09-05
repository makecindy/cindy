import type { NewSessionDraft } from "./newSession";
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
}

export interface DurableOutboxRecord {
  version: 1;
  accountId: string;
  deviceId: string;
  item: MobileOutboxItem;
  createdAt: number;
  state: "queued" | "sending" | "confirming" | "host-owned" | "failed";
  uploads: DurableUpload[];
  prepared?: QueuedRemoteMessage;
  clearBoundaryMs?: number | null;
  /** Only hosts advertising durable delivery may receive an uncertain retry. */
  retrySafe?: boolean;
  error?: string;
  cancelRequested?: boolean;
  sendAtMs?: number;
  suspended?: boolean;
  template?: QueuedRemoteMessage;
  refreshUploads?: boolean;
  creation?: {
    draft: NewSessionDraft;
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

const PREFIX = "cindy.mobile.outbox.v1.";
const EMPTY: readonly DurableOutboxRecord[] = Object.freeze([]);
const keyFor = (
  r: Pick<DurableOutboxRecord, "accountId" | "deviceId" | "item">,
) =>
  PREFIX +
  [r.accountId, r.deviceId, r.item.sessionId, r.item.clientId]
    .map(encodeURIComponent)
    .join("/");

/** Write-through message ownership. Views are published only after the durable write succeeds. */
export function createDurableOutbox(storage: OutboxStorage) {
  let accountId = "";
  let generation = 0;
  let records: readonly DurableOutboxRecord[] = EMPTY;
  let writes: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> = Promise.resolve();
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
    await ready;
    return serialize(async () => {
      assertOwner(record.accountId, epoch);
      const current = records.find((r) => keyFor(r) === keyFor(record));
      if (adding ? current !== undefined : current !== record)
        throw new Error("OUTBOX_STALE_WRITE");
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
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => records,
    getAccountId: () => accountId,
    activate(owner: string): Promise<void> {
      if (owner === accountId) return ready;
      accountId = owner;
      const epoch = ++generation;
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
          const record = JSON.parse(raw) as DurableOutboxRecord;
          // Corruption must be visible; never overwrite or silently drop unsent work.
          if (
            record.version !== 1 ||
            record.accountId !== owner ||
            !record.deviceId ||
            !record.item?.sessionId ||
            !record.item.clientId ||
            keyFor(record) !== key ||
            !Array.isArray(record.uploads) ||
            ![
              "queued",
              "sending",
              "confirming",
              "host-owned",
              "failed",
            ].includes(record.state) ||
            !Number.isFinite(record.createdAt) ||
            !Array.isArray(record.item.attachmentSlots)
          )
            throw new Error("OUTBOX_STORAGE_INVALID");
          loaded.push(record);
        }
        assertOwner(owner, epoch);
        records = loaded.sort((a, b) => a.createdAt - b.createdAt);
        emit();
      });
      return ready;
    },
    async add(record: DurableOutboxRecord) {
      if (!record.accountId || !record.deviceId)
        throw new Error("OUTBOX_OWNER_REQUIRED");
      await ready;
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
    ready: () => ready,
  };
}

export type DurableOutboxStore = ReturnType<typeof createDurableOutbox>;

/** Synchronous page observer: reserve a transcript slot before the sender's await resumes. */
export function observeDurableOutboxSending(
  store: DurableOutboxStore,
  deviceId: string,
  sessionId: string,
  onSending: (record: DurableOutboxRecord) => void,
  onSettled: (clientId: string) => void,
): () => void {
  const accountId = store.getAccountId();
  const scoped = () => store.getSnapshot().filter((r) => r.accountId === accountId
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
