/** The coordinator boundary used by Orca shutdown queue cleanup. */
export interface OrcaShutdownQueueCoordinator {
  ensureQueueRestored: (sessionId: string) => Promise<void>;
  getProjection: (sessionId: string) => {
    pendingQueue: ReadonlyArray<{ clientId: string }>;
  };
  remove: (sessionId: string, clientId: string) => unknown;
}

/**
 * Discard only the pending input belonging to one Worker being shut down.
 *
 * The coordinator's remove() is intentional: it emits onDiscardedQueuedMessage,
 * which releases Orca accepted callbacks, scheduler discard watchers, and any
 * other queue-owned resources. Do not clear coordinator internals directly.
 */
export async function discardPendingOrcaWorkerInput(
  coordinator: OrcaShutdownQueueCoordinator,
  sessionId: string,
): Promise<number> {
  await coordinator.ensureQueueRestored(sessionId).catch(() => undefined);
  const clientIds = coordinator.getProjection(sessionId).pendingQueue.map((item) => item.clientId);
  for (const clientId of clientIds) coordinator.remove(sessionId, clientId);
  return clientIds.length;
}
