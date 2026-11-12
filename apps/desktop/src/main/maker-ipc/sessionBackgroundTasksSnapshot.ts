/**
 * Snapshot of a live session's background tasks, shared by the desktop IPC
 * handler (`maker:session-background-tasks:list`) and the Node Host.
 *
 * Type-only imports and no top-level side effects, so the Host can load it.
 */

import type { BackgroundTaskSnapshot } from '@cindy/maker-core';

export interface SessionBackgroundTasksSource {
  listBackgroundTasks(): BackgroundTaskSnapshot[];
  countPendingWakeContinuations(): number;
}

export interface SessionBackgroundTasks {
  tasks: BackgroundTaskSnapshot[];
  /**
   * Continuation claims whose task already ended but whose wake turn has not
   * started or is still running. `tasks` drops a task as soon as it ends, so the
   * renderer's wake bridge may only settle when this is 0, never on empty tasks.
   */
  pendingContinuations: number;
}

/** A session that is not live has no running background tasks. */
export function snapshotSessionBackgroundTasks(live: SessionBackgroundTasksSource | undefined): SessionBackgroundTasks {
  return {
    tasks: live ? live.listBackgroundTasks() : [],
    pendingContinuations: live ? live.countPendingWakeContinuations() : 0,
  };
}
