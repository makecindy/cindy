import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { runSourceGit } from './sourceGit.js';
import type { CindyMakeTaskError } from '../../shared/cindyMakeDoctor.js';
import {
  CINDY_MAKE_RUN_ID_PATTERN,
  CINDY_PERSONAL_BRANCH,
  makeSourceCheckoutPath,
  makeTaskBranch,
  makeTaskWorktreePath,
  makeWorktreesRoot,
} from './sourcePaths.js';

export type MakeTaskAction = 'finish' | 'delete';
export type MakeTaskError = CindyMakeTaskError;
export function taskError(code: MakeTaskError): Error & { code: MakeTaskError } {
  return Object.assign(new Error('Cindy Make task ' + code), { code });
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Only operates on a registered managed worktree or its verified deletion residue. */
export async function manageCindyMakeWorkspace(
  userData: string,
  runId: string,
  action: MakeTaskAction | 'archive',
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  options: {
    git?: typeof runSourceGit;
    baseCommit?: string;
    checkCurrent?: () => void;
    /** Main's persisted preparation result, never supplied by the renderer. */
    preparedWorkspace?: { path: string; branch: string };
  } = {},
): Promise<boolean> {
  if (!CINDY_MAKE_RUN_ID_PATTERN.test(runId)) throw taskError('unavailable');
  const source = makeSourceCheckoutPath(userData);
  const target = makeTaskWorktreePath(userData, runId);
  const branch = makeTaskBranch(runId);
  const check = options.checkCurrent ?? (() => {});
  const git = async (args: string[], cwd = source) => {
    check();
    return (options.git ?? runSourceGit)(env, args, cwd, signal);
  };
  const targetExists = await exists(target);
  const samePath = (left: string, right: string) =>
    process.platform === 'win32'
      ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
      : path.resolve(left) === path.resolve(right);
  const canonicalProfile = await realpath(userData);
  // Reject substituted roots as well as a symlink at the leaf. Never follow a
  // junction out of this profile, including when a previous cleanup was partial.
  const assertManagedPaths = async () => {
    check();
    for (const directory of [path.dirname(source), source, makeWorktreesRoot(userData), target]) {
      if (!(await exists(directory))) continue;
      if (
        (await lstat(directory)).isSymbolicLink() ||
        !samePath(
          await realpath(directory),
          path.join(canonicalProfile, path.relative(userData, directory)),
        )
      )
        throw taskError('unavailable');
    }
  };
  await assertManagedPaths();
  if (!(await exists(path.join(source, '.git')))) {
    if (!targetExists && action === 'delete') return true;
    throw taskError('unavailable');
  }
  const gitDirectory = await lstat(path.join(source, '.git'));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) throw taskError('unavailable');
  const branchExists = !!(await git(['branch', '--list', branch])).trim();
  if (!targetExists && !branchExists) return true;
  const registrations = async () =>
    (await git(['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map((entry) => {
      const lines = entry.split('\0');
      return {
        directory: lines.find((line) => line.startsWith('worktree '))?.slice(9),
        branch: lines.find((line) => line.startsWith('branch '))?.slice(7),
      };
    });
  const gitMarker = path.join(target, '.git');
  let verifiedWorkspace =
    options.preparedWorkspace?.branch === branch &&
    samePath(options.preparedWorkspace.path, target);
  const canRemoveResidue = async () => {
    if (action !== 'delete' || !verifiedWorkspace || !branchExists || (await exists(gitMarker)))
      return false;
    return !(await registrations()).some(
      (entry) =>
        (entry.directory && samePath(entry.directory, target)) ||
        entry.branch === 'refs/heads/' + branch,
    );
  };
  let registered = false;
  if (targetExists) {
    registered = (await registrations()).some(
      (entry) =>
        entry.directory &&
        samePath(entry.directory, target) &&
        entry.branch === 'refs/heads/' + branch,
    );
    if (!registered) {
      if (!(await canRemoveResidue())) throw taskError('unavailable');
    } else {
      if ((await git(['rev-parse', '--abbrev-ref', 'HEAD'], target)).trim() !== branch)
        throw taskError('unavailable');
      const common = (
        await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], target)
      ).trim();
      if (!samePath(await realpath(common), await realpath(path.join(source, '.git'))))
        throw taskError('unavailable');
      verifiedWorkspace = true;
    }
  }
  if (action !== 'delete') {
    if (!branchExists) throw taskError('unavailable');
    if (
      targetExists &&
      (await git(['status', '--porcelain', '--untracked-files=all'], target)).trim()
    ) {
      if (action === 'archive') return false;
      throw taskError('dirty');
    }
    const head = (await git(['rev-parse', branch])).trim();
    if (action === 'archive' && (!options.baseCommit || head === options.baseCommit)) return false;
    let merged = false;
    try {
      await git(['merge-base', '--is-ancestor', branch, CINDY_PERSONAL_BRANCH]);
      merged = true;
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode !== 1) throw error;
    }
    if (!merged && action === 'archive') return false;
    if (!merged) {
      if (await exists(path.join(source, '.git', 'MERGE_HEAD'))) throw taskError('dirty');
      if (
        (await git(['status', '--porcelain', '--untracked-files=all'])).trim() ||
        (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() !== CINDY_PERSONAL_BRANCH
      )
        throw taskError('dirty');
      try {
        await git([
          '-c',
          'user.name=Cindy Make',
          '-c',
          'user.email=cindy-make@localhost',
          'merge',
          '--no-edit',
          '--signoff',
          branch,
        ]);
      } catch {
        // The source was clean before our merge. Abort only a merge that Git
        // actually started; a pre-existing merge is never touched.
        if (await exists(path.join(source, '.git', 'MERGE_HEAD'))) await git(['merge', '--abort']);
        throw taskError('conflict');
      }
    }
    // Recheck after merge: external edits must not be discarded by --force.
    if (
      targetExists &&
      (await git(['status', '--porcelain', '--untracked-files=all'], target)).trim()
    )
      throw taskError('dirty');
  }
  if (targetExists && registered) {
    try {
      // pnpm paths routinely exceed Win32's legacy MAX_PATH.
      await git(['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', target]);
    } catch (error) {
      // Git can erase the registration and .git file even when removing files
      // fails. Keep the branch until the leftover directory is gone.
      if (!(await canRemoveResidue())) throw error;
    }
  }
  if (targetExists && (await exists(target))) {
    if (!(await canRemoveResidue())) throw taskError('cleanupFailed');
    await assertManagedPaths();
    check();
    signal.throwIfAborted();
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code ?? ''))
        throw taskError('directoryBusy');
      throw error;
    }
  }
  if (!targetExists) await git(['worktree', 'prune']);
  if (branchExists) await git(['branch', action === 'delete' ? '-D' : '-d', branch]);
  return true;
}
