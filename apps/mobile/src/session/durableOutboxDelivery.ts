import type { InputDeliveryProjection } from "@cindy/device-link";
import { isExplicitRemoteNotFoundError } from "./newSessionWorktree";
import {
  createDurableOutbox,
  isDurableOutboxHandedOff,
  isDurableOutboxSettled,
  isDurableOutboxUnsent,
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
export type OutboxSessionPolicy = 'deliver' | 'discard' | 'wait';
export interface DurableOutboxDeliveryDeps {
  store: ReturnType<typeof createDurableOutbox>;
  isCurrent(): boolean;
  canRun(record: DurableOutboxRecord): boolean;
  sessionPolicy?(record: DurableOutboxRecord): Promise<OutboxSessionPolicy>;
  projection(record: DurableOutboxRecord): Promise<DeliveryProjection>;
  /**
   * A never-sent record may skip the pre-enqueue projection RPC when this host
   * is already known to support durable delivery and the task's clear boundary
   * is known. Return undefined to use the projection RPC.
   */
  knownProjection?(record: DurableOutboxRecord): DeliveryProjection | undefined;
  /** Host rejected a clear-boundary precondition that came from `knownProjection`. */
  staleClearBoundary?(error: unknown): boolean;
  /** Phone-local timing diagnostics only; never receives message content. */
  trace?(event: string, fields: Record<string, number | string | boolean>): void;
  session(record: DurableOutboxRecord): Promise<{ id: string; status: string } | null>;
  prepare(record: DurableOutboxRecord): Promise<QueuedRemoteMessage>;
  upload(
    record: DurableOutboxRecord,
    upload: DurableUpload,
  ): Promise<RemoteSerializedAttachment>;
  enqueue(record: DurableOutboxRecord): Promise<InputProjection>;
  /** Recheck resource ownership before recording that an external write has started. */
  beforeEnqueue?(record: DurableOutboxRecord): Promise<void>;
  cancel(record: DurableOutboxRecord): Promise<boolean>;
  history(record: DurableOutboxRecord): Promise<boolean>;
  /** A remote row alone cannot release the local bubble before offline history owns it. */
  cacheHistory?(record: DurableOutboxRecord): Promise<boolean>;
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
  let scanning = false;
  let rescan = false;
  let stopped = false;
  let cursor = 0;
  const due = new Map<string, number>();
  const attempts = new Map<string, number>();
  /** Records currently inside `deliver`; a later run never starts the same record twice. */
  const inFlight = new Set<string>();
  /** A stale known boundary was rejected once; this record must ask the host instead. */
  const requireProjection = new Set<string>();
  const id = (r: DurableOutboxRecord) =>
    JSON.stringify([r.deviceId, r.item.sessionId, r.item.clientId]);
  const current = (r: DurableOutboxRecord) =>
    !stopped && deps.isCurrent() && deps.store.getSnapshot().includes(r);
  const hasDurableOwnership = (r: DurableOutboxRecord) =>
    r.state === "host-owned" && isDurableOutboxHandedOff(r);
  /** Nothing has been sent or prepared, so no host receipt can matter yet. */
  const neverSent = (r: DurableOutboxRecord) =>
    r.state === "queued" && isDurableOutboxUnsent(r) && !r.prepared
    && !r.cancelRequested && !r.refreshUploads && !requireProjection.has(id(r));
  const trace = (event: string, fields: Record<string, number | string | boolean>) => {
    try {
      deps.trace?.(event, fields);
    } catch {
      /* diagnostics never affect delivery */
    }
  };
  const hasHistory = async (record: DurableOutboxRecord): Promise<boolean> => {
    try {
      return await deps.history(record);
    } catch (error) {
      // Pending and withdrawn inputs need not have a history row. Absence is
      // not a delivery failure or proof of cancellation; host receipts decide.
      if (isExplicitRemoteNotFoundError(error)) return false;
      throw error;
    }
  };
  async function deliver(initial: DurableOutboxRecord) {
    let record = initial;
    // The upload in progress when an attempt throws is the image that did not get through.
    let uploadingSlot: number | undefined;
    due.set(id(record), Date.now() + 5_000);
    const startedAt = Date.now();
    let markAt = startedAt;
    const stagesMs: Record<string, number> = {};
    const stage = (name: string) => {
      const now = Date.now();
      stagesMs[name] = now - markAt;
      markAt = now;
    };
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
      requireProjection.delete(id(record));
    };
    const finishHistory = async () => {
      if (!current(record)) return;
      trace("send history confirmed", {
        client: record.item.clientId.slice(0, 8),
        clickToHistoryMs: Date.now() - record.createdAt,
      });
      if (deps.cacheHistory && !await deps.cacheHistory(record)) {
        // Even a legacy host has durably accepted this row. Retaining its local
        // bubble must not block later sends or make the old message retryable.
        if (current(record) && !record.historyConfirmed)
          await update({ state: 'host-owned', historyConfirmed: true, error: undefined });
        return;
      }
      if (current(record)) await finish();
    };
    try {
      if (deps.sessionPolicy && !isDurableOutboxSettled(record)) {
        const policy = await deps.sessionPolicy(record);
        if (!current(record) || policy === 'wait') return;
        if (policy === 'discard') return await finish(isDurableOutboxUnsent(record));
        stage('policy');
      }
      if (record.draftHandoff) {
        await deps.store.reconcileDrafts(record.item.sessionId);
        const reconciled = deps.store.getSnapshot().find((r) => id(r) === id(record));
        if (!reconciled || !current(reconciled)) return;
        record = reconciled;
      }
      // Persisted completion never re-enters delivery, even after missing files or lost host history.
      if (isDurableOutboxSettled(record)) return await finish();
      // Reentry may restore history without restoring the raw message window.
      // Its persisted user row is already sufficient proof for a host-owned
      // send; do not keep its pending bubble behind projection/history RPCs.
      if (hasDurableOwnership(record) && !record.cancelRequested && deps.cacheHistory
        && await deps.cacheHistory(record)) {
        if (current(record)) await finish();
        return;
      }
      if (!current(record)) return;
      // A first attempt has no receipt to reconcile. When the host's durable
      // delivery support and the task's clear boundary are already known, the
      // enqueue itself is the only round trip; the host still enforces the
      // boundary and a stale one is retried once through the projection below.
      const knownProjection = neverSent(record) ? deps.knownProjection?.(record) : undefined;
      let projection: DeliveryProjection;
      if (knownProjection) projection = knownProjection;
      else try {
        projection = await deps.projection(record);
      } catch (error) {
        if (!current(record)) return;
        if (isExplicitRemoteNotFoundError(error)) {
          // NOT_FOUND also covers hidden tasks and tasks not created yet. Only a
          // positive tombstone for this exact task authorizes terminal cleanup.
          const session = await deps.session(record);
          if (!current(record)) return;
          if (session?.id === record.item.sessionId && session.status === "deleted") {
            // Local preparation is not a send. Older prepared rows remain
            // uncertain; only an explicit pre-enqueue record proves ownership.
            return await finish(isDurableOutboxUnsent(record));
          }
        }
        throw error;
      }
      if (!current(record)) return;
      if (!knownProjection) deps.applyProjection(record, projection);
      stage('projection');
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
        if (isDurableOutboxUnsent(record) && state === "unknown")
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
        } else if (await hasHistory(record)) {
          await finishHistory();
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
        if (await hasHistory(record)) {
          await finishHistory();
          return;
        }
        if (!current(record)) return;
        if (!hasDurableOwnership(record) || record.error)
          await update({ state: "host-owned", retrySafe: true, error: undefined });
        due.set(id(record), Date.now() + 5_000);
        return;
      }
      // Even old hosts may already have persisted a user row after the enqueue receipt was lost.
      if ((record.prepared || state === "pending" || state === "accepted") && (await hasHistory(record))) {
        await finishHistory();
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
          uploadingSlot = upload.slot;
          const attachment = await deps.upload(record, upload);
          uploadingSlot = undefined;
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
              failedUploadSlot: undefined,
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
          enqueueStarted: record.enqueueStarted ?? (record.sendAtMs === undefined ? false : undefined),
          clearBoundaryMs: projection.clearBoundaryMs !== undefined
            ? projection.clearBoundaryMs : record.clearBoundaryMs,
          sendAtMs: record.sendAtMs ?? Date.now(),
        });
        stage('prepare');
      }
      await deps.beforeEnqueue?.(record);
      if (!current(record) || !deps.canRun(record)) return;
      // This write precedes every external enqueue. Crash recovery therefore knows it must reconcile.
      await update({ state: "sending", enqueueStarted: true, error: undefined });
      let result: InputProjection;
      try {
        result = await deps.enqueue(record);
      } catch (error) {
        // The host refused the known boundary before accepting anything. Undo
        // only that local preparation and ask the host once, like the first send
        // would have; a second refusal follows the ordinary cleared-task path.
        if (knownProjection && current(record) && deps.staleClearBoundary?.(error)) {
          requireProjection.add(id(record));
          await update({
            state: "queued",
            prepared: undefined,
            retrySafe: undefined,
            clearBoundaryMs: undefined,
            enqueueStarted: false,
            error: undefined,
          });
          due.delete(id(record));
          rescan = true;
          trace("send known boundary rejected", { client: record.item.clientId.slice(0, 8) });
          return;
        }
        throw error;
      }
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
      stage('enqueue');
      trace("send accepted", {
        client: record.item.clientId.slice(0, 8),
        knownProjection: knownProjection !== undefined,
        durable: durableEnqueue,
        clickToAcceptedMs: Date.now() - record.createdAt,
        deliverMs: Date.now() - startedAt,
        ...stagesMs,
      });
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
        failedUploadSlot: uploadingSlot,
        ...(!isDurableOutboxSettled(record) && deps.mediaFailed?.(error) && record.uploads.length
          ? { refreshUploads: true }
          : {}),
      }).catch(() => undefined);
    }
  }
  // Bound aggregate replay as well as concurrency; reconnecting many tasks must not
  // recreate a relay backpressure burst.
  const MAX_IN_FLIGHT = 2;
  async function run(): Promise<void> {
    if (stopped || !deps.isCurrent()) return;
    // A request that arrives while another run is choosing work, or while every
    // delivery slot is busy, is remembered and replayed as soon as a slot frees.
    // A new message therefore never waits for the periodic tick behind an
    // unrelated reconciliation.
    if (scanning || inFlight.size >= MAX_IN_FLIGHT) {
      rescan = true;
      return;
    }
    scanning = true;
    rescan = false;
    const work: DurableOutboxRecord[] = [];
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
      // A head already being delivered still holds its session's place in line.
      const candidates = [...groups.values()]
        .flatMap((group) => {
          const head = group.find((r) => !isDurableOutboxHandedOff(r));
          return [
            ...(head ? [head] : []),
            ...group.filter(isDurableOutboxHandedOff),
          ];
        })
        .filter((r) => !inFlight.has(id(r)) && deps.canRun(r) && (due.get(id(r)) ?? 0) <= Date.now());
      // Round robin prevents one failed head starving peers.
      const capacity = Math.min(MAX_IN_FLIGHT - inFlight.size, candidates.length);
      for (let n = 0; n < capacity; n++) {
        work.push(candidates[(cursor + n) % candidates.length]!);
      }
      cursor = candidates.length
        ? (cursor + work.length) % candidates.length
        : 0;
      for (const record of work) inFlight.add(id(record));
    } finally {
      scanning = false;
    }
    // Each delivery frees its own slot as soon as it settles, so a message added
    // while a slow peer is still replying can use that slot immediately.
    await Promise.all(
      work.map((record) =>
        deliver(record).finally(() => {
          inFlight.delete(id(record));
          if (rescan && !stopped) {
            rescan = false;
            void run().catch(() => undefined);
          }
        }),
      ),
    );
  }
  return {
    stop() {
      stopped = true;
    },
    wake() {
      due.clear();
    },
    run,
  };
}
