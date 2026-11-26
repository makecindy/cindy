import type { AgentInputCoordinator } from './agent-input-coordinator.js';

/**
 * The input-queue facts the idle-release watchers read before they close a runtime. Shared by
 * the desktop (register.ts) and the Node Host, so both judge "this task still has input" alike.
 */
export type IdleReleaseInputCoordinator = Pick<
  AgentInputCoordinator,
  | 'ensureQueueRestored'
  | 'isQueueRestored'
  | 'hasPendingQueuedWork'
  | 'hasQueuedItemWhere'
  | 'isAutoResumePending'
  | 'hasQueuedAutoResume'
  | 'getAutoResumeAttemptToken'
>;

/** Pending input that keeps a runtime: a queued follow-up, or a durable queue not yet restored. */
export async function hasPendingIdleReleaseInput(
  inputCoordinator: IdleReleaseInputCoordinator,
  sessionId: string,
): Promise<boolean> {
  await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
  // A failed restore is itself a pending condition: never close a worker while
  // its durable follow-up snapshot is still unavailable.
  if (!inputCoordinator.isQueueRestored(sessionId)) return true;
  return (
    inputCoordinator.hasPendingQueuedWork(sessionId) ||
    inputCoordinator.hasQueuedItemWhere(sessionId, () => true, { includeRecovery: true })
  );
}

/** The queue and auto-resume part of the Claude and Codex watchers' isHostBusy. */
export function hasIdleReleaseQueuedWork(inputCoordinator: IdleReleaseInputCoordinator, id: string): boolean {
  return inputCoordinator.hasPendingQueuedWork(id)
      || inputCoordinator.hasQueuedItemWhere(id, () => true, { includeRecovery: true })
      || inputCoordinator.isAutoResumePending(id)
      || inputCoordinator.hasQueuedAutoResume(id)
      || inputCoordinator.getAutoResumeAttemptToken(id) !== null;
}

/** The Pi watcher's scheduled auto-resume check. */
export function hasScheduledIdleReleaseAutoResume(
  coordinator: IdleReleaseInputCoordinator,
  sessionId: string,
): boolean {
  return (
    coordinator.isAutoResumePending(sessionId) ||
    coordinator.getAutoResumeAttemptToken(sessionId) !== null ||
    coordinator.hasQueuedAutoResume(sessionId)
  );
}
