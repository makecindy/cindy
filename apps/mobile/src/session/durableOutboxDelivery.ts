import type { InputDeliveryProjection } from "@cindy/device-link";
import {
  createDurableOutbox,
  isDurableOutboxSettled,
  type DurableOutboxRecord,
  type DurableUpload,
} from "./durableOutbox";
import type {
  InputProjection,
  QueuedRemoteMessage,
  RemoteSerializedAttachment,
} from "./types";

export type DeliveryProjection = InputProjection &
  InputDeliveryProjection & { clearBoundaryMs?: number | null };
export interface DurableOutboxDeliveryDeps {
  store: ReturnType<typeof createDurableOutbox>;
  isCurrent(): boolean;
  canRun(record: DurableOutboxRecord): boolean;
  projection(record: DurableOutboxRecord): Promise<DeliveryProjection>;
  prepare(record: DurableOutboxRecord): Promise<QueuedRemoteMessage>;
  upload(
    record: DurableOutboxRecord,
    upload: DurableUpload,
  ): Promise<RemoteSerializedAttachment>;
  enqueue(record: DurableOutboxRecord): Promise<InputProjection>;
  cancel(record: DurableOutboxRecord): Promise<boolean>;
  history(record: DurableOutboxRecord): Promise<boolean>;
  applyProjection(
    record: DurableOutboxRecord,
    projection: InputProjection,
  ): void;
  cleanup(record: DurableOutboxRecord, cancelled: boolean): Promise<void>;
  discardUploads(record: DurableOutboxRecord, attachments: RemoteSerializedAttachment[]): void;
  accepted?(record: DurableOutboxRecord): Promise<void>;
  mediaFailed?(error: unknown): boolean;
  retryable(error: unknown): boolean;
  describe(error: unknown): string;
  confirmationMessage: string;
  clearedMessage: string;
}

/** One owner for writes; pages only add records or request retry/cancellation. */
export function createDurableOutboxDelivery(deps: DurableOutboxDeliveryDeps) {
  let running = false;
  let stopped = false;
  let cursor = 0;
  const due = new Map<string, number>();
  const attempts = new Map<string, number>();
  const id = (r: DurableOutboxRecord) =>
    JSON.stringify([r.deviceId, r.item.sessionId, r.item.clientId]);
  const current = (r: DurableOutboxRecord) =>
    !stopped && deps.isCurrent() && deps.store.getSnapshot().includes(r);
  const hasDurableOwnership = (r: DurableOutboxRecord) =>
    r.state === "host-owned" && r.retrySafe === true;
  async function deliver(initial: DurableOutboxRecord) {
    let record = initial;
    due.set(id(record), Date.now() + 5_000);
    const update = async (patch: Partial<DurableOutboxRecord>) => {
      if (!current(record)) throw new Error("OUTBOX_STALE_WRITE");
      record = await deps.store.update(record, patch);
    };
    const finish = async (cancelled = false) => {
      if (!current(record)) return;
      if (!isDurableOutboxSettled(record)) {
        await update({ state: 'host-owned', cleanupOutcome: cancelled ? 'cancelled' : 'accepted', error: undefined });
      }
      if (!current(record)) return;
      await deps.cleanup(record, record.cleanupOutcome === 'cancelled');
      if (!current(record)) return;
      await deps.store.remove(record);
      due.delete(id(record));
      attempts.delete(id(record));
    };
    try {
      // Persisted completion never re-enters delivery, even after missing files or lost host history.
      if (isDurableOutboxSettled(record)) return await finish();
      const projection = await deps.projection(record);
      if (!current(record)) return;
      deps.applyProjection(record, projection);
      const receipt = projection.deliveryReceipts?.find(
        (r) => r.clientId === record.item.clientId,
      );
      const state =
        receipt?.state ??
        (projection.pendingQueue.some(
          (r) => r.clientId === record.item.clientId,
        )
          ? "pending"
          : "unknown");
      // A legacy queue projection or enqueue response only proves in-memory acceptance.
      const durableOwnership =
        hasDurableOwnership(record) ||
        (projection.inputDeliveryVersion === 1 &&
          (receipt?.state === "pending" || receipt?.state === "accepted"));
      if (record.cancelRequested) {
        if (!record.prepared && state === "unknown")
          return await finish(true);
        if (projection.inputDeliveryVersion === 1) {
          const cancelled = await deps.cancel(record);
          if (!current(record)) return;
          if (cancelled) await finish(true);
          else {
            await deps.accepted?.(record);
            await update({
              state: "host-owned",
              retrySafe: true,
              cancelRequested: false,
              error: undefined,
            });
          }
        } else if (state === 'removed') {
          await finish();
        } else if (state === "pending") {
          // Legacy hosts cannot seal a not-yet-arrived enqueue. Keep uncertain cancellation visible.
          await update({ state: "failed", error: deps.confirmationMessage });
        } else if (await deps.history(record)) {
          if (current(record)) await finish();
        } else if (current(record)) {
          await update({ state: "failed", error: deps.confirmationMessage });
        }
        return;
      }
      if (state === "removed") return await finish();
      if (
        record.clearBoundaryMs !== undefined &&
        projection.clearBoundaryMs !== undefined &&
        record.clearBoundaryMs !== projection.clearBoundaryMs
      ) {
        if (durableOwnership)
          return await finish();
        await update({ state: "failed", error: deps.clearedMessage });
        return;
      }
      if (durableOwnership) {
        if (record.state !== "host-owned") await deps.accepted?.(record);
        if (!current(record)) return;
        if (await deps.history(record)) {
          if (current(record)) await finish();
          return;
        }
        if (!current(record)) return;
        if (!hasDurableOwnership(record))
          await update({ state: "host-owned", retrySafe: true, error: undefined });
        due.set(id(record), Date.now() + 5_000);
        return;
      }
      // Even old hosts may already have persisted a user row after the enqueue receipt was lost.
      if ((record.prepared || state === "pending" || state === "accepted") && (await deps.history(record))) {
        if (current(record)) await finish();
        return;
      }
      if (!current(record) || record.state === "failed") return;
      if (state === "pending" || state === "accepted" || record.state === "host-owned") {
        await update({ state: state === "pending" ? "confirming" : "failed", error: deps.confirmationMessage });
        return;
      }
      if (
        record.prepared &&
        (record.state === "sending" || record.state === "confirming") &&
        !record.refreshUploads &&
        !(record.retrySafe && projection.inputDeliveryVersion === 1)
      ) {
        await update({ state: "failed", error: deps.confirmationMessage });
        return;
      }
      if (record.refreshUploads && record.uploads.length) {
        const superseded = record.item.attachmentSlots.filter((attachment, slot): attachment is RemoteSerializedAttachment =>
          attachment !== null && record.uploads.some((upload) => upload.slot === slot));
        await update({
          template: record.prepared ?? record.template,
          prepared: undefined,
          refreshUploads: false,
          item: {
            ...record.item,
            attachmentSlots: record.item.attachmentSlots.map((slot, index) =>
              record.uploads.some((u) => u.slot === index) ? null : slot,
            ),
          },
        });
        if (!current(record)) return;
        // Commit the replacement boundary first: a failed ledger write still owns the old references.
        deps.discardUploads(record, superseded);
      }
      if (!record.prepared) {
        for (const upload of record.uploads) {
          if (record.item.attachmentSlots[upload.slot]) continue;
          const attachment = await deps.upload(record, upload);
          let retained = false;
          try {
            if (!current(record)) return;
            await update({
              item: {
                ...record.item,
                attachmentSlots: record.item.attachmentSlots.map((old, slot) =>
                  slot === upload.slot ? attachment : old,
                ),
                waitingIds: record.item.waitingIds.filter(
                  (localId) => record.item.slotByLocalId[localId] !== upload.slot,
                ),
                failedIds: record.item.failedIds.filter(
                  (localId) => record.item.slotByLocalId[localId] !== upload.slot,
                ),
              },
            });
            retained = true;
          } finally {
            // Until the ledger owns it, this attempt owns the remote object, including late completion.
            if (!retained) deps.discardUploads(record, [attachment]);
          }
        }
        const prepared = await deps.prepare(record);
        if (!current(record)) return;
        await update({
          prepared: {
            ...prepared,
            // Snapshot Plan on this input, never arm the session during preparation.
            ...(record.creation ? {
              createOpts: { ...prepared.createOpts, planMode: record.creation.planModeArm },
            } : {}),
            ...(projection.inputDeliveryVersion === 1
              ? { durableDelivery: true }
              : {}),
          },
          retrySafe: projection.inputDeliveryVersion === 1,
          clearBoundaryMs: projection.clearBoundaryMs ?? record.clearBoundaryMs,
          sendAtMs: record.sendAtMs ?? Date.now(),
        });
      }
      // This write precedes every external enqueue. Crash recovery therefore knows it must reconcile.
      await update({ state: "sending", error: undefined });
      const result = await deps.enqueue(record);
      if (!current(record)) return;
      deps.applyProjection(record, result);
      const durableEnqueue = record.prepared?.durableDelivery === true &&
        projection.inputDeliveryVersion === 1;
      if (durableEnqueue) await deps.accepted?.(record);
      await update(durableEnqueue
        ? { state: "host-owned" }
        : { state: "confirming", error: deps.confirmationMessage });
      attempts.delete(id(record));
      due.set(id(record), Date.now() + 1_000);
    } catch (error) {
      if (!current(record)) return;
      const count = (attempts.get(id(record)) ?? 0) + 1;
      attempts.set(id(record), count);
      due.set(
        id(record),
        Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(count, 5)),
      );
      // Never turn an uncertain write into a fresh message or discard its ID.
      await update({
        state:
          isDurableOutboxSettled(record)
            ? record.state
            : record.state === "sending"
              ? "confirming"
              : deps.retryable(error)
                ? record.state
                : "failed",
        error: deps.describe(error),
        ...(!isDurableOutboxSettled(record) && deps.mediaFailed?.(error) && record.uploads.length
          ? { refreshUploads: true }
          : {}),
      }).catch(() => undefined);
    }
  }
  return {
    stop() {
      stopped = true;
    },
    wake() {
      due.clear();
    },
    async run() {
      if (running || stopped || !deps.isCurrent()) return;
      running = true;
      try {
        await deps.store.ready();
        if (stopped || !deps.isCurrent()) return;
        const groups = new Map<string, DurableOutboxRecord[]>();
        for (const record of deps.store.getSnapshot()) {
          const key = JSON.stringify([record.deviceId, record.item.sessionId]);
          const group = groups.get(key) ?? [];
          group.push(record);
          groups.set(key, group);
        }
        // Session FIFO, while one unavailable computer never blocks a different task.
        const candidates = [...groups.values()]
          .flatMap((group) => {
            const handedOff = (r: DurableOutboxRecord) => hasDurableOwnership(r) || isDurableOutboxSettled(r);
            const head = group.find((r) => !handedOff(r));
            return [
              ...(head ? [head] : []),
              ...group.filter(handedOff),
            ];
          })
          .filter((r) => deps.canRun(r) && (due.get(id(r)) ?? 0) <= Date.now());
        // Bound aggregate replay as well as concurrency; reconnecting many tasks must not
        // recreate a relay backpressure burst. Round robin prevents one failed head starving peers.
        const work: DurableOutboxRecord[] = [];
        for (let n = 0; n < Math.min(2, candidates.length); n++) {
          work.push(candidates[(cursor + n) % candidates.length]!);
        }
        cursor = candidates.length
          ? (cursor + work.length) % candidates.length
          : 0;
        await Promise.all(work.map(deliver));
      } finally {
        running = false;
      }
    },
  };
}
