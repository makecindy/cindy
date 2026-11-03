import { MAX_RECYCLE_FAILURES, recyclePolicy } from './recyclePolicy';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { app } from 'electron';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import {
  listRecycleRecords, listRecycleRecordsWithHistory, pruneUnreferencedRecoveryArchives, readRecycleRecord,
  watchRecycleJournal, worktreeGeneration, writeRecycleRecord, type WorktreeRecycleRecord,
} from './recycleJournal';
import { listSnapshotRefs, releaseSnapshotRef, SNAPSHOT_REF_PREFIX } from './contentSnapshot';
import type { LocalWorktreeReference } from '../localDb/worker/worktreeReferences';
import { recycleManagedWorktree } from './managedRecycle';
import { hasLiveSessionReference, loadLiveSessionPathKeys, pathKey } from './liveSessionRefs';
import * as store from './worktreeStore';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { subscribeWorktreeRecycleEvents } from './recycleEvents';
import { retryPendingWorktreeRuntimeLeaseReleases } from './runtimeLeases';

const log = createLogger('worktreeRecycleMaintenance');
let maintenance: WorktreeRecycleMaintenance | null = null;
const MAX_ATTEMPTS = 8;
const EVENT_COALESCE_MS = 100;
const STARTUP_DELAY_MS = 30_000;
const SNAPSHOT_CLEANUP_BUDGET_MS = 5_000;
const SNAPSHOT_GIT_TIMEOUT_MS = 1_000;
const retryDelay = (attempt: number): number => Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempt, 9));

export interface WorktreeMaintenanceOptions {
  isReady(): boolean;
  onReady?(): Promise<void>;
  recycleCurrentSession(sessionId: string, status: string): Promise<void>;
  onAttemptComplete?(): Promise<void>;
}

/** Paused for the directory's identity or location, not for the old archive flow: never retried. */
const unsafeResourceReasons = new Set([
  'legacy-quarantine-needs-review', 'directory-replaced', 'unmanaged-path', 'redirected-worktree-parent',
]);

/**
 * Older clients paused requests after archive failures (timeouts, a disk filled by archives,
 * Windows EPERM/EBUSY/ENAMETOOLONG while packing). None of that work exists any more, so each
 * such request gets one fresh failure budget; a fault that persists pauses it again.
 */
function grantsLegacyArchiveRetry(record: WorktreeRecycleRecord): boolean {
  return !record.legacyArchiveRetry && !record.snapshot?.untracked
    && ['pending', 'snapshotted', 'removing'].includes(record.phase)
    && recyclePolicy(record).state === 'paused' && record.reason !== undefined && !unsafeResourceReasons.has(record.reason);
}

/** Event-driven, single-flight maintenance with one timer for the earliest pending deadline. */
export class WorktreeRecycleMaintenance {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private running: Promise<void> | null = null;
  private dirty = false;
  private stopped = false;
  private stopWatching: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private watchFailures = 0;
  private watchRetryAt = 0;
  private scanFailures = 0;
  private initialPass = true;
  private startAt: number | null = null;
  private readonly wakeIds = new Set<string>();
  private readonly attempts = new Map<string, { count: number; checks: number; notBefore: number }>();

  constructor(public options: WorktreeMaintenanceOptions) {}

  start(delayMs = 0): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.startAt ??= Date.now() + delayMs;
    this.unsubscribe ??= subscribeWorktreeRecycleEvents((event) => {
      if (event.opportunity) this.wakeIds.add(event.resourceId);
      this.changed();
    });
    return this.run();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopWatching?.();
    this.stopWatching = null;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private schedule(at: number): void {
    if (this.stopped || !Number.isFinite(at) || (this.timer && this.timerAt <= at)) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => { this.clearTimer(); void this.run(); }, Math.max(1, at - Date.now()));
    this.timer.unref();
  }

  private changed(): void {
    if (this.stopped) return;
    if (this.running) this.dirty = true;
    else this.schedule(Date.now() + EVENT_COALESCE_MS);
  }

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.startAt !== null && Date.now() < this.startAt) {
      this.schedule(this.startAt);
      return Promise.resolve();
    }
    if (this.running) { this.dirty = true; return this.running; }
    this.clearTimer();
    this.dirty = false;
    this.running = this.runPass().catch((error) => {
      log.warn('worktree retry postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
      if (++this.scanFailures <= MAX_ATTEMPTS) this.schedule(Date.now() + retryDelay(this.scanFailures));
    }).finally(() => {
      this.running = null;
      if (this.dirty) this.schedule(Date.now() + EVENT_COALESCE_MS);
    });
    return this.running;
  }

  private async ensureWatcher(): Promise<void> {
    if (this.stopWatching || this.watchFailures >= MAX_ATTEMPTS || this.watchRetryAt > Date.now()) return;
    const failed = (error: unknown) => {
      this.stopWatching?.();
      this.stopWatching = null;
      log.warn('worktree journal watch postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
      this.watchRetryAt = Date.now() + retryDelay(++this.watchFailures);
      if (this.watchFailures < MAX_ATTEMPTS) this.schedule(this.watchRetryAt);
    };
    try {
      const close = await watchRecycleJournal(() => this.changed(), failed);
      if (this.stopped) close();
      else { this.stopWatching = close; this.watchFailures = 0; this.watchRetryAt = 0; }
    } catch (error) { failed(error); }
  }

  private key(record: WorktreeRecycleRecord): string { return `${record.id}:${record.generation}`; }

  private eligible(record: WorktreeRecycleRecord, opportunity = false): boolean {
    const state = recyclePolicy(record).state;
    if (state === 'paused' || state === 'kept' || (state === 'waiting' && !opportunity)) return false;
    if (record.phase === 'restored' || record.phase === 'restoring' || record.meta.ephemeral) return false;
    const current = store.get(record.meta.sessionId);
    if (record.phase === 'removed' && !current) return false;
    // Runtime-release hints can wake reference waits, never a paused failure budget.
    return !current || worktreeGeneration(current) === record.generation;
  }

  isRetrySuspended(record: WorktreeRecycleRecord): boolean {
    return (this.attempts.get(this.key(record))?.count ?? 0) >= MAX_RECYCLE_FAILURES;
  }

  private chargeAttempt(record: WorktreeRecycleRecord): void {
    const previous = this.attempts.get(this.key(record));
    this.attempts.set(this.key(record), {
      count: (previous?.count ?? 0) + 1,
      checks: previous?.checks ?? 1,
      notBefore: previous?.notBefore ?? Date.now() + retryDelay(1),
    });
  }

  private deadline(record: WorktreeRecycleRecord): number {
    if (this.isRetrySuspended(record)) return Infinity;
    return Math.max(record.nextAttemptAt, this.attempts.get(this.key(record))?.notBefore ?? 0);
  }

  /**
   * Recycling no longer builds recovery archives. Once per start, delete archives nothing can
   * decrypt, and give requests that older clients paused (usually an archive timeout or a disk
   * filled by archives) one fresh failure budget. Paused-by-user or identity faults stay put.
   */
  private async retireRecoveryArchives(records: readonly WorktreeRecycleRecord[]): Promise<boolean> {
    let granted = false;
    try {
      const pruned = await pruneUnreferencedRecoveryArchives();
      if (pruned > 0) log.info('removed unreferenced worktree recovery archives', { count: pruned });
      for (const candidate of records) {
        if (!grantsLegacyArchiveRetry(candidate)) continue;
        await withWorktreeResourceLock(candidate.meta.path, async () => {
          const record = await readRecycleRecord(candidate.meta.path);
          if (!record || record.id !== candidate.id || record.generation !== candidate.generation
            || !grantsLegacyArchiveRetry(record)) return;
          record.retryPolicy = { state: 'retrying', failures: 0, failedWorkMs: 0 };
          record.reason = undefined;
          record.attempts = 0;
          record.nextAttemptAt = 0;
          record.legacyArchiveRetry = true;
          await writeRecycleRecord(record);
          granted = true;
        });
      }
    } catch (error) {
      log.warn('worktree recovery archive retirement postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
    }
    return granted;
  }

  private async releaseObsoleteSnapshots(): Promise<void> {
    try {
      const db = getDbClient();
      const readRows = db.readLocalWorktreeReferences?.bind(db);
      if (!readRows) return;
      const released = await releaseObsoleteRecoverySnapshots(readRows,
        () => !this.stopped && this.options.isReady() && getDbClient() === db);
      if (released > 0) log.info('released obsolete worktree recovery snapshots', { count: released });
    } catch (error) {
      log.warn('worktree recovery snapshot release postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
    }
  }

  private async runPass(): Promise<void> {
    if (!this.options.isReady()) return;
    await this.options.onReady?.();
    if (this.stopped || !this.options.isReady()) return;
    await this.ensureWatcher();
    if (this.stopped) return;
    let pendingLeaseReleases = 0;
    try { pendingLeaseReleases = await retryPendingWorktreeRuntimeLeaseReleases(); }
    catch (error) { log.warn('worktree runtime lease release retry postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' }); pendingLeaseReleases = 1; }
    if (pendingLeaseReleases > 0) this.schedule(Date.now() + retryDelay(1));
    let records = await listRecycleRecords();
    if (this.initialPass && await this.retireRecoveryArchives(records)) records = await listRecycleRecords();
    if (this.initialPass) await this.releaseObsoleteSnapshots();
    const wakeIds = new Set(this.wakeIds);
    this.wakeIds.clear();
    // A resource may have been released while Cindy was closed: recheck waits
    // once on startup, but never reset a persisted fault/keep decision.
    if (this.initialPass) {
      for (const record of records) if (recyclePolicy(record).state === 'waiting') wakeIds.add(record.id);
      this.initialPass = false;
    }
    for (const record of records) if (wakeIds.has(record.id)) this.attempts.delete(this.key(record));
    const due = records.filter((record) => this.eligible(record, wakeIds.has(record.id))
      && (wakeIds.has(record.id) || this.deadline(record) <= Date.now()));
    // Empty queues and not-yet-due requests never open task databases.
    if (due.length) {
      for (const record of due) {
        const previous = this.attempts.get(this.key(record));
        const checks = (previous?.checks ?? 0) + 1;
        // A missing owner is not a failed removal. Keep a bounded-rate metadata
        // recheck so account/database visibility can recover without a resource event.
        this.attempts.set(this.key(record), {
          count: previous?.count ?? 0, checks, notBefore: Date.now() + retryDelay(checks),
        });
      }
      await this.retry(due, wakeIds);
    }
    if (this.stopped || !this.options.isReady()) return;
    this.scanFailures = 0;
    // Removal and other instances may have changed these records while we waited.
    const latest = due.length ? await listRecycleRecords() : records;
    for (const record of latest) if (this.eligible(record)) this.schedule(this.deadline(record));
    if (!this.stopWatching && this.watchFailures < MAX_ATTEMPTS) this.schedule(this.watchRetryAt);
  }

  private async retry(records: WorktreeRecycleRecord[], wakeIds: ReadonlySet<string>): Promise<void> {
    const db = getDbClient();
    if (!db.readLocalWorktreeReferences) return;
    let attempted = false;
    try {
      const rows = await db.readLocalWorktreeReferences();
      const rowsByOwner = new Map<string, LocalWorktreeReference[]>();
      let scanned = 0;
      for (const row of rows) {
        let owned = rowsByOwner.get(row.id);
        if (!owned) { owned = []; rowsByOwner.set(row.id, owned); }
        owned.push(row);
        if (++scanned % 128 === 0) await setImmediate();
      }
      for (const record of records) {
        if (this.stopped || !this.options.isReady() || getDbClient() !== db) return;
        let charged = false;
        try {
          const latest = await readRecycleRecord(record.meta.path);
          if (this.stopped || !this.options.isReady() || getDbClient() !== db) return;
          if (!latest || !this.eligible(latest, wakeIds.has(record.id)) || latest.generation !== record.generation
            || latest.phase === 'restored' || latest.phase === 'restoring'
            || (latest.phase === 'removed' && !store.get(latest.meta.sessionId))
            || (!wakeIds.has(record.id) && latest.nextAttemptAt > Date.now())) continue;
          const ownerRows = rowsByOwner.get(record.meta.sessionId) ?? [];
          // Unknown is not an orphan, including after switching the selected account.
          if (!ownerRows.length || ownerRows.some((row) => row.source === 'bot'
            || (row.status !== 'archived' && row.status !== 'deleted'))) continue;
          this.chargeAttempt(record);
          charged = true;
          attempted = true;
          const currentRow = ownerRows.find((row) => row.currentDatabase);
          if (currentRow) {
            await this.options.recycleCurrentSession(record.meta.sessionId, currentRow.status!);
          } else {
            // Other databases supply evidence only; never close their tasks through the selected DB.
            await recycleManagedWorktree(record.meta, {
              canRemove: async () => {
                if (this.stopped || !this.options.isReady() || getDbClient() !== db) return false;
                const refs = (await db.readLocalWorktreeReferences!()).filter((row) => row.id === record.meta.sessionId);
                const request = await readRecycleRecord(record.meta.path);
                return request?.generation === record.generation && refs.length > 0
                  && refs.every((row) => row.source !== 'bot' && (row.status === 'archived' || row.status === 'deleted'));
              },
            });
          }
        } catch (error) {
          if (!charged) this.chargeAttempt(record);
          log.warn('worktree request postponed', { resourceId: record.id, code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
        }
      }
    } catch (error) {
      for (const record of records) this.chargeAttempt(record);
      log.warn('worktree references postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
    }
    if (attempted && !this.stopped) await this.options.onAttemptComplete?.();
  }
}

/**
 * Delete snapshot refs nothing can restore from: the worktree was restored, or it was removed
 * and every known database marks its task deleted. Startup-only, like the savepoint sweep, so
 * the regular recycle path never reads task databases; a status change itself never deletes
 * recovery evidence. Archived tasks keep their snapshots because they can be unarchived; a
 * task missing from the databases is unknown, not deleted. Task databases are read only when a
 * removed record needs its owner checked. Costs one Git process per repository with
 * candidates, plus one per ref actually deleted. Metadata is indexed in bounded batches;
 * the Git phase has a time budget, leaving unfinished refs for the next startup.
 */
export async function releaseObsoleteRecoverySnapshots(
  readRows: () => Promise<readonly LocalWorktreeReference[]>,
  canContinue: () => boolean = () => true,
): Promise<number> {
  const records = await listRecycleRecordsWithHistory();
  if (!records || !canContinue()) return 0;
  // History keeps an older copy of the same record, so decide per ref across all copies.
  const copies = new Map<string, {
    baseRepo: string; commit: string; restored: boolean; removed: boolean; owners: Set<string>;
  }>();
  let scanned = 0;
  for (const record of records) {
    if (++scanned % 128 === 0) {
      await setImmediate();
      if (!canContinue()) return 0;
    }
    if (!record.snapshot?.ref.startsWith(SNAPSHOT_REF_PREFIX)) continue;
    let copy = copies.get(record.snapshot.ref);
    if (!copy) {
      copy = { baseRepo: record.meta.baseRepo, commit: record.snapshot.commit,
        restored: false, removed: true, owners: new Set() };
      copies.set(record.snapshot.ref, copy);
    }
    copy.restored ||= record.phase === 'restored';
    copy.removed &&= record.phase === 'removed';
    copy.owners.add(record.meta.sessionId);
  }
  let needsOwners = false;
  for (const copy of copies.values()) {
    if (++scanned % 128 === 0) await setImmediate();
    if (!copy.restored && copy.removed) { needsOwners = true; break; }
  }
  if (!canContinue()) return 0;
  const rows = needsOwners ? await readRows() : [];
  // All databases must agree. A missing owner remains unknown, never deleted.
  const deletedOwners = new Map<string, boolean>();
  for (const row of rows) {
    const id = row.id;
    deletedOwners.set(id, (deletedOwners.get(id) ?? true) && row.source !== 'bot' && row.status === 'deleted');
    if (++scanned % 128 === 0) {
      await setImmediate();
      if (!canContinue()) return 0;
    }
  }
  const byRepo = new Map<string, Array<{ ref: string; commit: string }>>();
  for (const [ref, copy] of copies) {
    if (++scanned % 128 === 0) {
      await setImmediate();
      if (!canContinue()) return 0;
    }
    let obsolete = copy.restored;
    if (!obsolete && copy.removed) {
      obsolete = true;
      for (const owner of copy.owners) {
        if (++scanned % 128 === 0) await setImmediate();
        if (deletedOwners.get(owner) !== true) { obsolete = false; break; }
      }
    }
    if (!obsolete) continue;
    let candidates = byRepo.get(copy.baseRepo);
    if (!candidates) { candidates = []; byRepo.set(copy.baseRepo, candidates); }
    candidates.push({ ref, commit: copy.commit });
  }
  // Do not budget the evidence scan: a partial journal must never authorize deletion.
  // The existing Git helper may spend its bounded process-tree cleanup grace after timeout.
  const deadlineAtMs = performance.now() + SNAPSHOT_CLEANUP_BUDGET_MS;
  const gitOptions = { timeoutMs: SNAPSHOT_GIT_TIMEOUT_MS, deadlineAtMs };
  let released = 0;
  for (const [baseRepo, candidates] of byRepo) {
    if (!canContinue() || performance.now() >= deadlineAtMs) break;
    let existing: Map<string, string>;
    try { existing = await listSnapshotRefs(baseRepo, gitOptions); } catch { continue; }
    for (const candidate of candidates) {
      if (++scanned % 128 === 0) await setImmediate();
      if (!canContinue() || performance.now() >= deadlineAtMs) return released;
      if (existing.get(candidate.ref) === candidate.commit && await releaseSnapshotRef(baseRepo, candidate, gitOptions)) released++;
    }
  }
  return released;
}

/** Starts once both task storage and runtime-close services are usable. */
export function startWorktreeRecycleMaintenance(options: WorktreeMaintenanceOptions): void {
  maintenance ??= new WorktreeRecycleMaintenance(options);
  maintenance.options = options;
  void maintenance.start(STARTUP_DELAY_MS);
}

export function stopWorktreeRecycleMaintenance(): void {
  maintenance?.stop();
  maintenance = null;
}

/** Read-only classification: upgrading never turns historical registrations into deletion requests. */
export async function auditRegisteredWorktrees(): Promise<void> {
  const refs = await loadLiveSessionPathKeys();
  const entries = [];
  for (const meta of store.getAll()) {
    let directory: 'present' | 'missing' | 'unreadable' | 'residual' = 'present';
    let physicalPath = pathKey(meta.path);
    try {
      await fs.lstat(meta.path);
      physicalPath = await physicalWorktreeKey(meta.path);
      try { await fs.lstat(path.join(meta.path, '.git')); } catch (error) {
        directory = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'residual' : 'unreadable';
      }
    } catch (error) {
      directory = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    const record = await readRecycleRecord(meta.path);
    entries.push({ sessionId: meta.sessionId, path: meta.path, physicalPath, directory,
      referenced: refs === null ? null : hasLiveSessionReference(meta, refs),
      recycle: record?.phase ?? 'historical-review', reason: record?.reason,
    });
  }
  const summary = {
    registered: entries.length,
    physicalPaths: new Set(entries.map((entry) => entry.physicalPath)).size,
    existingDirectories: new Set(entries.filter((entry) => entry.directory === 'present' || entry.directory === 'residual').map((entry) => entry.physicalPath)).size,
    referencedPaths: new Set(entries.filter((entry) => entry.referenced).map((entry) => entry.physicalPath)).size,
  };
  await fs.writeFile(path.join(app.getPath('userData'), 'worktree-audit.json'), JSON.stringify({ at: new Date().toISOString(), summary, entries }), { mode: 0o600 });
  log.info('worktree registry audit completed', summary);
}

/** Fallback for failures before the journal can be written (for example a locked volume). */
export function isWorktreeRecycleRetrySuspended(record: WorktreeRecycleRecord): boolean {
  return maintenance?.isRetrySuspended(record) ?? false;
}
