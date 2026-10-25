import { app } from 'electron';

import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
import {
  listRecycleRecords,
  readRecycleRecord,
  watchRecycleJournal,
  worktreeGeneration,
} from './recycleJournal';
import { recycleManagedWorktree } from './managedRecycle';
import { loadLiveSessionPathKeys } from './liveSessionRefs';
import * as store from './worktreeStore';
import { physicalWorktreeKey } from './resourceLock';
import { subscribeWorktreeRecycleEvents } from './recycleEvents';
import { retryPendingWorktreeRuntimeLeaseReleases } from './runtimeLeases';
import { gitExec } from './gitExec';
import { releaseSnapshotRef } from './contentSnapshot';

import { createWorktreeRecycleMaintenance } from '@cindy/worktree-core/recycleMaintenance';
export type { WorktreeMaintenanceOptions } from '@cindy/worktree-core/recycleMaintenance';
export const {
  WorktreeRecycleMaintenance,
  startWorktreeRecycleMaintenance,
  stopWorktreeRecycleMaintenance,
  auditRegisteredWorktrees,
  isWorktreeRecycleRetrySuspended,
} = createWorktreeRecycleMaintenance({
  store,
  physicalWorktreeKey,
  log: createLogger('worktreeRecycleMaintenance'),
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
});
export type WorktreeRecycleMaintenance = InstanceType<typeof WorktreeRecycleMaintenance>;

/** Startup-only cleanup for snapshot refs that no remaining task can restore. */
export async function releaseObsoleteRecoverySnapshots(
  readRows: () => Promise<
    ReadonlyArray<{ id: string; status?: string | null; source?: string | null }>
  >,
  canContinue: () => boolean = () => true,
): Promise<number> {
  if (!canContinue()) return 0;
  const records = await listRecycleRecords();
  const copies = new Map<
    string,
    { baseRepo: string; commit: string; restored: boolean; removed: boolean; owners: Set<string> }
  >();
  for (const record of records) {
    const snapshot = record.snapshot;
    if (!snapshot?.ref.startsWith('refs/cindy/worktree-recovery/')) continue;
    let copy = copies.get(snapshot.ref);
    if (!copy) {
      copy = {
        baseRepo: record.meta.baseRepo,
        commit: snapshot.commit,
        restored: false,
        removed: true,
        owners: new Set(),
      };
      copies.set(snapshot.ref, copy);
    }
    copy.restored ||= record.phase === 'restored';
    copy.removed &&= record.phase === 'removed';
    copy.owners.add(record.meta.sessionId);
  }
  const rows = [...copies.values()].some((copy) => copy.removed && !copy.restored)
    ? await readRows()
    : [];
  const deleted = new Map<string, boolean>();
  for (const row of rows)
    deleted.set(
      row.id,
      (deleted.get(row.id) ?? true) && row.source !== 'bot' && row.status === 'deleted',
    );
  let released = 0;
  for (const [ref, copy] of copies) {
    if (!canContinue()) break;
    let obsolete = copy.restored;
    if (!obsolete && copy.removed)
      obsolete = [...copy.owners].every((owner) => deleted.get(owner) === true);
    if (!obsolete) continue;
    const { stdout } = await gitExec(
      ['for-each-ref', '--format=%(refname)%00%(objectname)', ref],
      copy.baseRepo,
    );
    const [existingRef, existingCommit] = stdout.trim().split('\0');
    if (
      existingRef === ref &&
      existingCommit === copy.commit &&
      (await releaseSnapshotRef(copy.baseRepo, { ref, commit: copy.commit }))
    )
      released++;
  }
  return released;
}
