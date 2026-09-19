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

export function isCindyMakeWorktreePath(userData: string, workingDir: string): boolean {
  const relative = path.relative(makeWorktreesRoot(userData), path.resolve(workingDir));
  return (
    relative.length > 0 &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    CINDY_MAKE_RUN_ID_PATTERN.test(relative)
  );
}

/** Shared filesystem protection only; this does not grant the personal-build harness. */
export function isCindyMakeManagedWorktreePath(userData: string, workingDir: string): boolean {
  if (isCindyMakeWorktreePath(userData, workingDir)) return true;
  const relative = path.relative(path.join(makeSourceRoot(userData), 'merge-worktrees'), path.resolve(workingDir));
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(relative);
}
