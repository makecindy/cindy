import { recyclePolicy } from './recyclePolicy';
import { setImmediate } from 'node:timers/promises';
import type { WorktreeSessionReference } from '@cindy/worktree-core/managerPorts';
import { SNAPSHOT_REF_PREFIX } from '@cindy/worktree-core/contentSnapshot';
import { app } from 'electron';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import {
  listRecycleRecords,
  pruneUnreferencedRecoveryArchives,
  writeRecycleRecord,
  type WorktreeRecycleRecord,
  listRecycleRecordsWithHistory,
  readRecycleRecord,
  watchRecycleJournal,
  worktreeGeneration,
} from './recycleJournal';
import { recycleManagedWorktree } from './managedRecycle';
import { loadLiveSessionPathKeys } from './liveSessionRefs';
import * as store from './worktreeStore';
import { physicalWorktreeKey, withWorktreeResourceLock } from './resourceLock';
import { subscribeWorktreeRecycleEvents } from './recycleEvents';
import { retryPendingWorktreeRuntimeLeaseReleases } from './runtimeLeases';

import { releaseSnapshotRef, listSnapshotRefs } from './contentSnapshot';

import { createWorktreeRecycleMaintenance } from '@cindy/worktree-core/recycleMaintenance';
export type { WorktreeMaintenanceOptions } from '@cindy/worktree-core/recycleMaintenance';

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

const log = createLogger('worktreeRecycleMaintenance');
const SNAPSHOT_CLEANUP_BUDGET_MS = 5_000;
const SNAPSHOT_GIT_TIMEOUT_MS = 1_000;
export const {
  WorktreeRecycleMaintenance,
  startWorktreeRecycleMaintenance,
  stopWorktreeRecycleMaintenance,
  auditRegisteredWorktrees,
  isWorktreeRecycleRetrySuspended,
} = createWorktreeRecycleMaintenance({
  store,
  physicalWorktreeKey,
  log,
  loadLiveSessionPathKeys,
  recycleManagedWorktree,
  listRecycleRecords,
  readRecycleRecord,
  watchRecycleJournal,
  worktreeGeneration,
  subscribeWorktreeRecycleEvents,
  retryPendingWorktreeRuntimeLeaseReleases,
  userDataRoot: () => app.getPath('userData'),
  getReferenceSource: getDbClient,
  releaseObsoleteRecoverySnapshots,
  retireRecoveryArchives,
});
export type WorktreeRecycleMaintenance = InstanceType<typeof WorktreeRecycleMaintenance>;

export async function releaseObsoleteRecoverySnapshots(
  readRows: () => Promise<readonly WorktreeSessionReference[]>,
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

async function retireRecoveryArchives(records: readonly WorktreeRecycleRecord[]): Promise<boolean> {
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
