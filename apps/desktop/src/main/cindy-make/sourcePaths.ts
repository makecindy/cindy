import path from 'node:path';

/** Dependency-free path helpers so IPC validation can import them without the Git pipeline. */
export function makeSourceRoot(userData: string): string {
  return path.join(userData, 'cindy-make');
}

/**
 * The managed checkout. It stays on the personal baseline branch: packaging reads
 * from here, and no code task ever works in it directly.
 */
export function makeSourceCheckoutPath(userData: string): string {
  return path.resolve(makeSourceRoot(userData), 'source');
}

/** Parent of every per-task worktree; each task gets `<root>/worktrees/<runId>`. */
export function makeWorktreesRoot(userData: string): string {
  return path.resolve(makeSourceRoot(userData), 'worktrees');
}

/** The user's persistent personal baseline; every task branches from it and merges back into it. */
export const CINDY_PERSONAL_BRANCH = 'cindy-personal';

export const CINDY_MAKE_RUN_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Task branch name; the run id is validated by the caller against CINDY_MAKE_RUN_ID_PATTERN. */
export function makeTaskBranch(runId: string): string {
  return `cindy-make/${runId}`;
}

export function makeTaskWorktreePath(userData: string, runId: string): string {
  return path.resolve(makeWorktreesRoot(userData), runId);
}
