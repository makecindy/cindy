import type { InputDeliveryProjection } from "@cindy/device-link";
import {
  createDurableOutbox,
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
  cleanup(record: DurableOutboxRecord): Promise<void>;
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
  async function finish(record: DurableOutboxRecord) {
    if (!current(record)) return;
    await deps.store.remove(record);
    // Removing the ledger first leaves at worst an orphan file, never an accepted row with missing bytes.
    await deps.cleanup(record);
    due.delete(id(record));
    attempts.delete(id(record));
  }
  async function deliver(initial: DurableOutboxRecord) {
    let record = initial;
    due.set(id(record), Date.now() + 5_000);
    const update = async (patch: Partial<DurableOutboxRecord>) => {
      if (!current(record)) throw new Error("OUTBOX_STALE_WRITE");
      record = await deps.store.update(record, patch);
    };
    try {
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
      if (state === "removed") return await finish(record);
      if (record.cancelRequested) {
        if (!record.prepared && state === "unknown")
          return await finish(record);
        if (projection.inputDeliveryVersion === 1) {
          const cancelled = await deps.cancel(record);
          if (!current(record)) return;
          if (cancelled) await finish(record);
          else {
            await deps.accepted?.(record);
            await update({
              state: "host-owned",
              cancelRequested: false,
              error: undefined,
            });
          }
        } else if (state === "pending") {
          // Legacy hosts cannot seal a not-yet-arrived enqueue. Keep uncertain cancellation visible.
          await update({ state: "failed", error: deps.confirmationMessage });
        } else if (await deps.history(record)) {
          if (current(record)) await finish(record);
        }
        return;
      }
      if (
        record.clearBoundaryMs !== undefined &&
        projection.clearBoundaryMs !== undefined &&
        record.clearBoundaryMs !== projection.clearBoundaryMs
      ) {
        if (
          record.state === "host-owned" ||
          state === "accepted" ||
          state === "pending"
        )
          return await finish(record);
        await update({ state: "failed", error: deps.clearedMessage });
        return;
      }
      if (
        state === "accepted" ||
        state === "pending" ||
        record.state === "host-owned"
      ) {
        if (record.state !== "host-owned") await deps.accepted?.(record);
        if (!current(record)) return;
        if (await deps.history(record)) {
          if (current(record)) await finish(record);
          return;
        }
        if (!current(record)) return;
        if (record.state !== "host-owned")
          await update({ state: "host-owned", error: undefined });
        due.set(id(record), Date.now() + 5_000);
        return;
      }
      // Even old hosts may already have persisted a user row after the enqueue receipt was lost.
      if (record.prepared && (await deps.history(record))) {
        if (current(record)) await finish(record);
        return;
      }
      if (!current(record) || record.state === "failed") return;
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
      }
      if (!record.prepared) {
        for (const upload of record.uploads) {
          if (record.item.attachmentSlots[upload.slot]) continue;
          const attachment = await deps.upload(record, upload);
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
      await deps.accepted?.(record);
      await update({ state: "host-owned" });
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
          record.state === "sending"
            ? "confirming"
            : deps.retryable(error)
              ? record.state
              : "failed",
        error: deps.describe(error),
        ...(deps.mediaFailed?.(error) && record.uploads.length
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
            const head = group.find((r) => r.state !== "host-owned");
            return [
              ...(head ? [head] : []),
              ...group.filter((r) => r.state === "host-owned"),
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
