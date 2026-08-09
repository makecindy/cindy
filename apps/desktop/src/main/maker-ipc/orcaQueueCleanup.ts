/** The coordinator boundary used by Orca shutdown queue cleanup. */
export interface OrcaShutdownQueueCoordinator {
  ensureQueueRestored: (sessionId: string) => Promise<void>;
  getProjection: (sessionId: string) => {
    pendingQueue: ReadonlyArray<{ clientId: string }>;
  };
  remove: (sessionId: string, clientId: string) => unknown;
}

export interface OrcaPendingWorkerInputPlan {
  sessionId: string;
  clientIds: readonly string[];
}

/**
 * Prepare a durable-safe cleanup plan for one Worker without mutating its queue.
 *
 * The restore must succeed before the snapshot is trusted: a projection from an
 * un-restored coordinator can omit durable queued input.
 */
export async function preparePendingOrcaWorkerInput(
  coordinator: OrcaShutdownQueueCoordinator,
  sessionId: string,
): Promise<OrcaPendingWorkerInputPlan> {
  await coordinator.ensureQueueRestored(sessionId);
  return {
    sessionId,
    clientIds: coordinator.getProjection(sessionId).pendingQueue.map((item) => item.clientId),
  };
}

/**
 * Commit a prepared Worker queue cleanup after the team-end durable boundary.
 *
 * The coordinator's remove() is intentional: it emits onDiscardedQueuedMessage,
 * which releases Orca accepted callbacks, scheduler discard watchers, and any
 * other queue-owned resources. Do not clear coordinator internals directly.
 */
export function commitPendingOrcaWorkerInput(
  coordinator: OrcaShutdownQueueCoordinator,
  plan: OrcaPendingWorkerInputPlan,
): number {
  for (const clientId of plan.clientIds) coordinator.remove(plan.sessionId, clientId);
  return plan.clientIds.length;
}
