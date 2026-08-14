/**
 * Shared bridge to the Host's per-task send/route lock.
 *
 * The lock itself remains owned by maker-ipc. Local DB status writers and
 * destructive task cleanup use this injected bridge so a restore/status change
 * cannot cross the final removable check and irreversible media/worktree
 * cleanup. Tests and DB-only tools fall back to direct execution.
 */

export type SessionRouteLock = <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;

const passthroughLock: SessionRouteLock = async (_sessionId, task) => task();
let routeLock: SessionRouteLock = passthroughLock;

export function setSessionRouteLockImplementation(lock: SessionRouteLock | null): void {
  routeLock = lock ?? passthroughLock;
}

export function withSessionRouteLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  return routeLock(sessionId, task);
}

/** Acquire a batch in stable order so reversed overlapping batches cannot deadlock. */
export function withSessionRouteLocks<T>(
  sessionIds: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(sessionIds)].sort();
  const acquire = (index: number): Promise<T> => {
    const sessionId = ordered[index];
    if (sessionId === undefined) return task();
    return routeLock(sessionId, () => acquire(index + 1));
  };
  return acquire(0);
}
