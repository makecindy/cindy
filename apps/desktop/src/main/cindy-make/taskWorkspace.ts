import { access, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { CindyMakeTaskPreparation, MakeTaskWorkspace } from '../../shared/cindyMakeDoctor.js';
import { runSourceGit } from './sourceGit.js';
import { runSourcePnpm } from './sourcePnpm.js';
import {
  CINDY_MAKE_RUN_ID_PATTERN,
  CINDY_PERSONAL_BRANCH,
  isCindyMakeWorktreePath,
  makeSourceCheckoutPath,
  makeTaskBranch,
  makeTaskWorktreePath,
  makeWorktreesRoot,
} from './sourcePaths.js';

export type TaskWorkspacePhase = 'checking' | 'creating' | 'installing';

export interface TaskWorkspaceDeps {
  /** Toolchain PATH (system tools first, managed copies otherwise). */
  processEnvironment: NodeJS.ProcessEnv;
  git?: typeof runSourceGit;
  pnpm?: typeof runSourcePnpm;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or reuse) the per-task worktree: a fresh branch off the personal
 * baseline, checked out under `<root>/worktrees/<runId>`. Dependency installation
 * is a separate step after the task is visible. Reuse
 * keeps a retry after a crash from creating a second branch for the same task.
 */
export async function createCindyMakeWorktree(
  userData: string,
  runId: string,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
): Promise<MakeTaskWorkspace> {
  if (!CINDY_MAKE_RUN_ID_PATTERN.test(runId)) {
    throw Object.assign(new Error('invalid run id'), { code: 'gitFailed' });
  }
  const git = deps.git ?? runSourceGit;
  const env = deps.processEnvironment;
  const sourcePath = makeSourceCheckoutPath(userData);
  const worktreePath = makeTaskWorktreePath(userData, runId);
  const branch = makeTaskBranch(runId);
  onPhase('checking');
  if (!(await exists(path.join(sourcePath, '.git')))) {
    throw Object.assign(new Error('source missing'), { code: 'environmentNotReady' });
  }
  const hasPersonal = await git(
    env,
    ['branch', '--list', CINDY_PERSONAL_BRANCH],
    sourcePath,
    signal,
  );
  if (!hasPersonal.trim()) {
    throw Object.assign(new Error('personal branch missing'), { code: 'environmentNotReady' });
  }
  const baseCommit = await git(
    env,
    ['rev-parse', `${CINDY_PERSONAL_BRANCH}^{commit}`],
    sourcePath,
    signal,
  );
  const hasBranch = (await git(env, ['branch', '--list', branch], sourcePath, signal)).trim();
  const worktreeGitFile = path.join(worktreePath, '.git');
  if (await exists(worktreePath)) {
    // A reused worktree must be the real one Git registered for this branch,
    // not an unrelated directory or a symlink placed at the expected path.
    if ((await lstat(worktreePath)).isSymbolicLink() || !(await exists(worktreeGitFile))) {
      throw Object.assign(new Error('worktree path occupied'), { code: 'gitFailed' });
    }
    const current = (
      await git(env, ['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, signal)
    ).trim();
    if (current !== branch) {
      throw Object.assign(new Error('worktree on unexpected branch'), { code: 'gitFailed' });
    }
  } else {
    onPhase('creating');
    await mkdir(makeWorktreesRoot(userData), { recursive: true });
    if (hasBranch) {
      // Branch survived a removed directory (e.g. a manual clean-up). Prune the
      // stale registration and re-attach the branch rather than failing.
      await git(env, ['worktree', 'prune'], sourcePath, signal);
      await git(env, ['worktree', 'add', worktreePath, branch], sourcePath, signal);
    } else {
      await git(
        env,
        ['worktree', 'add', '-b', branch, worktreePath, CINDY_PERSONAL_BRANCH],
        sourcePath,
        signal,
      );
    }
  }
  return { path: worktreePath, branch, baseCommit: baseCommit.trim() };
}

/** Install dependencies in an already-created task worktree. */
export async function installCindyMakeWorktree(
  userData: string,
  workspace: MakeTaskWorkspace,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
  onProgress?: (progress: NonNullable<CindyMakeTaskPreparation['dependencies']>) => void,
): Promise<MakeTaskWorkspace> {
  const pnpm = deps.pnpm ?? runSourcePnpm;
  onPhase('installing');
  signal.throwIfAborted();
  if (!isCindyMakeWorktreePath(userData, workspace.path)) {
    throw Object.assign(new Error('invalid task workspace'), { code: 'gitFailed' });
  }
  await pnpm(
    deps.processEnvironment,
    ['install', '--frozen-lockfile', '--prefer-offline', '--prod=false'],
    workspace.path,
    signal,
    ...(onProgress ? [onProgress] : []),
  );
  signal.throwIfAborted();
  return workspace;
}

/** Backwards-compatible synchronous preparation used by existing callers/tests. */
export async function prepareCindyMakeWorkspace(
  userData: string,
  runId: string,
  signal: AbortSignal,
  deps: TaskWorkspaceDeps,
  onPhase: (phase: TaskWorkspacePhase) => void = () => {},
): Promise<MakeTaskWorkspace> {
  const workspace = await createCindyMakeWorktree(userData, runId, signal, deps, onPhase);
  return installCindyMakeWorktree(userData, workspace, signal, deps, onPhase);
}

export { isCindyMakeWorktreePath };
