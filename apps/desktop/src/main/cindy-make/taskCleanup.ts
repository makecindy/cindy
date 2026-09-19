import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { contentRef, snapshotContent, taskContentRef } from './sourceContent.js';
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

export type MakeTaskAction = 'end' | 'finish' | 'delete';
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
  action: MakeTaskAction | 'archive' | 'inspect',
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
  // Archiving alone never authorizes deleting a working directory.
  if (action === 'archive') return false;
  const discard = action === 'delete' || action === 'end';
  const source = makeSourceCheckoutPath(userData);
  const target = makeTaskWorktreePath(userData, runId);
  const branch = makeTaskBranch(runId);
  const check = options.checkCurrent ?? (() => {});
  const git = async (args: string[], cwd = source, indexFile?: string) => {
    check();
    return (options.git ?? runSourceGit)(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args,
      cwd,
      signal,
    );
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
    if (!targetExists && discard) return true;
    throw taskError('unavailable');
  }
  const gitDirectory = await lstat(path.join(source, '.git'));
  if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) throw taskError('unavailable');
  const branchExists = !!(await git(['branch', '--list', branch])).trim();
  if (action === 'inspect' && (!targetExists || !branchExists)) throw taskError('unavailable');
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
    if (!discard || !verifiedWorkspace || !branchExists || (await exists(gitMarker))) return false;
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
  let integrated: string | undefined;
  const integratedFilesMatch = async () => {
    if (!integrated || (await snapshotContent(git, target)) !== integrated) return false;
    const index = (await git(['write-tree'], target)).trim();
    const headTree = (await git(['rev-parse', 'HEAD^{tree}'], target)).trim();
    // Preserve staged-only edits that are absent from the integrated file tree.
    return index === headTree || index === integrated;
  };
  if (!discard) {
    if (!branchExists) throw taskError('unavailable');
    integrated = targetExists
      ? await contentRef(git, source, taskContentRef(runId, 'integrated'))
      : undefined;
    if (integrated) {
      if (!(await integratedFilesMatch())) return false;
    } else {
      if (
        targetExists &&
        (await git(['status', '--porcelain', '--untracked-files=all'], target)).trim()
      )
        return false;
      try {
        await git(['merge-base', '--is-ancestor', branch, CINDY_PERSONAL_BRANCH]);
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode === 1) return false;
        throw error;
      }
    }
    if (action === 'inspect') return true;
    // Closing a task never integrates files or creates commits. Only reclaim proven content.
    if (
      targetExists &&
      (integrated
        ? !(await integratedFilesMatch())
        : (await git(['status', '--porcelain', '--untracked-files=all'], target)).trim())
    )
      throw taskError('dirty');
    if (integrated)
      await git(['update-ref', 'refs/cindy-make/tasks/' + runId + '/history', branch]);
  }
  if (action === 'end' && branchExists)
    await git(['update-ref', 'refs/cindy-make/tasks/' + runId + '/history', branch]);
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
  if (branchExists) await git(['branch', discard || integrated ? '-D' : '-d', branch]);
  return true;
}
