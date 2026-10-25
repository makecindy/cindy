/**
 * Serializes snapshot restore/removal mutations for one owning session.
 *
 * A recycle cancellation and SEND-time recovery can both apply the same snapshot. Keeping a
 * shared tail per session makes every caller wait until the current snapshot owner finishes
 * mutating the worktree before it re-checks readiness.
 */
export function createWorktreeRestoreLocks() {
  const restoreMutationTails = new Map<string, Promise<void>>();
  let nextRestoreMutationVersion = 0;
  const restoreMutationVersions = new Map<string, number>();

  /** Returns the latest queued mutation version for one owning session. */
  function getWorktreeRestoreMutationVersion(sessionId: string): number {
    return restoreMutationVersions.get(sessionId) ?? 0;
  }

  /** Returns the current mutation tail, or null when the session has no restore mutation. */
  function getWorktreeRestoreMutation(sessionId: string): Promise<void> | null {
    return restoreMutationTails.get(sessionId) ?? null;
  }

  /** Runs one snapshot/worktree mutation after any earlier mutation for the same session. */
  function withWorktreeRestoreMutation<T>(
    sessionId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    restoreMutationVersions.set(sessionId, ++nextRestoreMutationVersion);
    const previous = restoreMutationTails.get(sessionId) ?? Promise.resolve();
    const run = previous.then(mutation, mutation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    restoreMutationTails.set(sessionId, tail);
    void tail.finally(() => {
      if (restoreMutationTails.get(sessionId) === tail) {
        restoreMutationTails.delete(sessionId);
      }
    });
    return run;
  }

  return {
    getWorktreeRestoreMutationVersion,
    getWorktreeRestoreMutation,
    withWorktreeRestoreMutation,
  };
}

export const {
  getWorktreeRestoreMutationVersion,
  getWorktreeRestoreMutation,
  withWorktreeRestoreMutation,
} = createWorktreeRestoreLocks();
