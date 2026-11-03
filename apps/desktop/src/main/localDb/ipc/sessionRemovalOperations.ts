export interface SessionRemovalOperationDeps {
  isOwnerCurrent(): boolean;
  isSessionStillRemovable(sessionId: string): Promise<boolean>;
  closeSession(sessionId: string): Promise<void>;
}

/**
 * Quiesce worktree writers while the session route lock is held. Eligibility
 * is checked again after Agent close because a user may restore the task
 * while its runtime is stopping.
 */
export async function quiesceSessionBeforeWorktreeRecycle(
  sessionId: string,
  deps: SessionRemovalOperationDeps,
): Promise<boolean> {
  if (!deps.isOwnerCurrent()) return false;
  if (!(await deps.isSessionStillRemovable(sessionId))) return false;
  if (!deps.isOwnerCurrent()) return false;
  await deps.closeSession(sessionId);
  if (!deps.isOwnerCurrent()) return false;
  return deps.isSessionStillRemovable(sessionId);
}
