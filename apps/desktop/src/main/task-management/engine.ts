import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  TaskArchiveNotice,
  TaskArchivePreview,
  TaskArchiveSettings,
} from '../../shared/taskManagement.js';
import { TASK_ARCHIVE_DAY_MS } from '../../shared/taskManagement.js';
import {
  taskArchiveKeepReason,
  type ArchiveCandidateRow,
  type ArchiveProtection,
} from './eligibility.js';

interface ArchivePorts {
  scope(): string;
  ownerId(): string;
  settings(): TaskArchiveSettings;
  canRun?(): boolean;
  restoredAt(): Record<string, number>;
  countActive(): Promise<number>;
  list(afterId: string): Promise<ArchiveCandidateRow[]>;
  read(id: string): Promise<ArchiveCandidateRow | undefined>;
  protection(): ArchiveProtection;
  busy(id: string): boolean;
  waiting?(id: string): boolean;
  pending(id: string): Promise<boolean>;
  withLock<T>(id: string, run: () => Promise<T>): Promise<T>;
  archive(id: string, cutoff: number, beforeWrite: () => void): Promise<number>;
  restore(id: string, beforeWrite: () => void): Promise<void>;
  notice(value: TaskArchiveNotice): void;
  now(): number;
  warn(error: unknown): void;
  yieldToUser?(): Promise<void>;
}

/** One host-owned scan at a time. Status writes always use the ordinary lifecycle. */
export function createTaskArchiveEngine(ports: ArchivePorts) {
  // A real timer leaves a gap in both the main event loop and the shared DB queue.
  // Awaiting an already-resolved promise alone would only yield to microtasks.
  const yieldToUser = ports.yieldToUser ?? (() => delay(25));
  let revision = 0;
  let flight: Promise<void> | null = null;
  let previewFlight: {
    scope: string;
    version: number;
    days: number;
    enabled: boolean;
    promise: Promise<TaskArchivePreview>;
  } | null = null;
  let lastCheck: { scope: string; at: number } | null = null;
  const batches = new Map<
    string,
    { scope: string; expiresAt: number; entries: Map<string, number> }
  >();
  const pruneBatches = (scope: string) => {
    for (const [id, batch] of batches)
      if (batch.scope !== scope || batch.expiresAt <= ports.now()) batches.delete(id);
  };
  const assertScope = (scope: string, version: number) => {
    if (ports.scope() !== scope || version !== revision)
      throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
  };
  const reason = (row: ArchiveCandidateRow, days: number, restoredAt: Record<string, number>) =>
    taskArchiveKeepReason(row, {
      now: ports.now(),
      days,
      restoredAt: restoredAt[row.id],
      protection: ports.protection(),
      busy: ports.busy(row.id),
      waiting: ports.waiting?.(row.id),
    });
  async function countPreview(
    scope: string,
    version: number,
    days: number,
    enabled: boolean,
  ): Promise<TaskArchivePreview> {
    const initialProtection = ports.protection();
    if (!enabled || !initialProtection.ready || initialProtection.remoteUnknown) {
      const keptCount = await ports.countActive();
      assertScope(scope, version);
      return {
        candidateCount: 0,
        keptCount,
        lastCheckAt: lastCheck?.scope === scope ? lastCheck.at : null,
      };
    }
    const restored = ports.restoredAt();
    const result: TaskArchivePreview = {
      candidateCount: 0,
      keptCount: 0,
      lastCheckAt: lastCheck?.scope === scope ? lastCheck.at : null,
    };
    let afterId = '';
    while (true) {
      const rows = await ports.list(afterId);
      assertScope(scope, version);
      if (!rows.length) break;
      const protection = ports.protection();
      const now = ports.now();
      for (const row of rows) {
        const keep =
          !enabled ||
          taskArchiveKeepReason(row, {
            now,
            days,
            restoredAt: restored[row.id],
            protection,
            busy: ports.busy(row.id),
            waiting: ports.waiting?.(row.id),
          });
        if (keep) result.keptCount++;
        else result.candidateCount++;
      }
      afterId = rows[rows.length - 1].id;
      await yieldToUser();
      assertScope(scope, version);
    }
    return result;
  }
  function preview(days = ports.settings().days): Promise<TaskArchivePreview> {
    const scope = ports.scope();
    const version = revision;
    const { enabled } = ports.settings();
    if (
      previewFlight?.scope === scope &&
      previewFlight.version === version &&
      previewFlight.days === days &&
      previewFlight.enabled === enabled
    )
      return previewFlight.promise;
    // Multiple windows share one in-flight count for the same owner and rule.
    // Do not retain a completed count: activity and draft state may have changed.
    const promise = countPreview(scope, version, days, enabled).finally(() => {
      if (previewFlight?.promise === promise) previewFlight = null;
    });
    previewFlight = { scope, version, days, enabled, promise };
    return promise;
  }
  async function scan(force: boolean) {
    const scope = ports.scope();
    const version = revision;
    const settings = ports.settings();
    if (!settings.enabled || ports.canRun?.() === false || !ports.protection().ready) return;
    if (!force && lastCheck?.scope === scope && ports.now() - lastCheck.at < TASK_ARCHIVE_DAY_MS)
      return;
    const restored = ports.restoredAt();
    const entries = new Map<string, number>();
    let afterId = '';
    let writesSinceYield = 0;
    let chunkStarted = ports.now();
    const pause = async () => {
      await yieldToUser();
      assertScope(scope, version);
      writesSinceYield = 0;
      chunkStarted = ports.now();
    };
    try {
      while (true) {
        const rows = await ports.list(afterId);
        assertScope(scope, version);
        if (!rows.length) break;
        for (const candidate of rows) {
          assertScope(scope, version);
          if (reason(candidate, settings.days, restored)) continue;
          try {
            await ports.withLock(candidate.id, async () => {
              assertScope(scope, version);
              if (await ports.pending(candidate.id)) return;
              const row = await ports.read(candidate.id);
              assertScope(scope, version);
              if (!row || reason(row, settings.days, restored)) return;
              const beforeWrite = () => {
                assertScope(scope, version);
                const latest = ports.settings();
                if (
                  !latest.enabled ||
                  latest.days !== settings.days ||
                  reason(row, settings.days, ports.restoredAt())
                ) {
                  throw new Error('TASK_ARCHIVE_NO_LONGER_IDLE');
                }
              };
              beforeWrite();
              const stamp = await ports.archive(
                row.id,
                ports.now() - settings.days * TASK_ARCHIVE_DAY_MS,
                beforeWrite,
              );
              entries.set(row.id, stamp);
            });
          } catch (error) {
            assertScope(scope, version);
            ports.warn(error);
          }
          // Release the route lock before yielding; new input must not wait for
          // the rest of the batch. Slow individual archives also yield promptly.
          if (++writesSinceYield >= 8 || ports.now() - chunkStarted >= 16) await pause();
        }
        afterId = rows[rows.length - 1].id;
        await pause();
      }
      lastCheck = { scope, at: ports.now() };
    } finally {
      if (entries.size && ports.scope() === scope) {
        pruneBatches(scope);
        const batchId = randomUUID();
        // Keep separate receipts for overlapping eight-second toasts. The extra
        // time allows delivery to a busy renderer without extending UI lifetime.
        batches.set(batchId, { scope, expiresAt: ports.now() + 60_000, entries });
        ports.notice({ ownerId: ports.ownerId(), batchId, count: entries.size });
      }
    }
  }
  return {
    preview,
    settled: () => flight ?? Promise.resolve(),
    invalidate() {
      revision++;
    },
    check(force = false): Promise<void> {
      if (flight) return flight;
      flight = scan(force)
        .catch(ports.warn)
        .finally(() => {
          flight = null;
        });
      return flight;
    },
    async undo(batchId: string) {
      const scope = ports.scope();
      pruneBatches(scope);
      const target = batches.get(batchId);
      if (!target) return { restored: 0 };
      let restored = 0;
      for (const [id, stamp] of target.entries) {
        await ports.withLock(id, async () => {
          if (ports.scope() !== scope) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
          const row = await ports.read(id);
          if (!row || row.status !== 'archived' || row.updatedAt !== stamp) return;
          await ports.restore(id, () => {
            if (ports.scope() !== scope) throw new Error('TASK_ARCHIVE_SCOPE_CHANGED');
          });
          target.entries.delete(id);
          restored++;
        });
      }
      return { restored };
    },
  };
}
