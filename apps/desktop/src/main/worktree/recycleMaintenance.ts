import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import { listRecycleRecords, readRecycleRecord, watchRecycleJournal, worktreeGeneration, type WorktreeRecycleRecord } from './recycleJournal';
import { recycleManagedWorktree } from './managedRecycle';
import { hasLiveSessionReference, loadLiveSessionPathKeys, pathKey } from './liveSessionRefs';
import * as store from './worktreeStore';
import { physicalWorktreeKey } from './resourceLock';
import { subscribeWorktreeRecycleEvents } from './recycleEvents';
import { retryPendingWorktreeRuntimeLeaseReleases } from './runtimeLeases';

const log = createLogger('worktreeRecycleMaintenance');
let maintenance: WorktreeRecycleMaintenance | null = null;
const MAX_ATTEMPTS = 8;
const EVENT_COALESCE_MS = 100;
const retryDelay = (attempt: number): number => Math.min(30 * 60_000, 5_000 * 2 ** Math.min(attempt, 9));

export interface WorktreeMaintenanceOptions {
  isReady(): boolean;
  recycleCurrentSession(sessionId: string, status: string): Promise<void>;
  onAttemptComplete?(): Promise<void>;
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
  private readonly wakeIds = new Set<string>();
  private readonly attempts = new Map<string, { count: number; notBefore: number }>();

  constructor(public options: WorktreeMaintenanceOptions) {}

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
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

  private eligible(record: WorktreeRecycleRecord): boolean {
    if (record.phase === 'restored' || record.phase === 'restoring' || record.meta.ephemeral) return false;
    const current = store.get(record.meta.sessionId);
    if (record.phase === 'removed' && !current) return false;
    // Attempts only control backoff. A directory may remain externally locked
    // longer than one backoff window; it must become eligible again when the
    // lock is released or the next deadline arrives.
    return !current || worktreeGeneration(current) === record.generation;
  }

  private deadline(record: WorktreeRecycleRecord): number {
    return Math.max(record.nextAttemptAt, this.attempts.get(this.key(record))?.notBefore ?? 0);
  }

  private async runPass(): Promise<void> {
    if (!this.options.isReady()) return;
    await this.ensureWatcher();
    if (this.stopped) return;
    let pendingLeaseReleases = 0;
    try { pendingLeaseReleases = await retryPendingWorktreeRuntimeLeaseReleases(); }
    catch (error) { log.warn('worktree runtime lease release retry postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' }); pendingLeaseReleases = 1; }
    if (pendingLeaseReleases > 0) this.schedule(Date.now() + retryDelay(1));
    const records = await listRecycleRecords();
    const wakeIds = new Set(this.wakeIds);
    this.wakeIds.clear();
    for (const record of records) if (wakeIds.has(record.id)) this.attempts.delete(this.key(record));
    const due = records.filter((record) => this.eligible(record)
      && (wakeIds.has(record.id) || this.deadline(record) <= Date.now()));
    // Empty queues and not-yet-due requests never open task databases.
    if (due.length) {
      for (const record of due) {
        const count = (this.attempts.get(this.key(record))?.count ?? 0) + 1;
        // Also back off errors before the removal core can persist nextAttemptAt.
        this.attempts.set(this.key(record), { count, notBefore: Date.now() + retryDelay(count) });
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
      for (const record of records) {
        if (this.stopped || !this.options.isReady() || getDbClient() !== db) return;
        try {
          const latest = await readRecycleRecord(record.meta.path);
          if (this.stopped || !this.options.isReady() || getDbClient() !== db) return;
          if (!latest || latest.generation !== record.generation
            || latest.phase === 'restored' || latest.phase === 'restoring'
            || (latest.phase === 'removed' && !store.get(latest.meta.sessionId))
            || (!wakeIds.has(record.id) && latest.nextAttemptAt > Date.now())) continue;
          const ownerRows = rows.filter((row) => row.id === record.meta.sessionId);
          // Unknown is not an orphan, including after switching the selected account.
          if (!ownerRows.length || ownerRows.some((row) => row.source === 'bot'
            || (row.status !== 'archived' && row.status !== 'deleted'))) continue;
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
          log.warn('worktree request postponed', { resourceId: record.id, code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
        }
      }
    } catch (error) {
      log.warn('worktree references postponed', { code: (error as NodeJS.ErrnoException).code ?? 'unavailable' });
    }
    if (attempted && !this.stopped) await this.options.onAttemptComplete?.();
  }
}

/** Starts once both task storage and runtime-close services are usable. */
export function startWorktreeRecycleMaintenance(options: WorktreeMaintenanceOptions): void {
  maintenance ??= new WorktreeRecycleMaintenance(options);
  maintenance.options = options;
  void maintenance.start();
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
