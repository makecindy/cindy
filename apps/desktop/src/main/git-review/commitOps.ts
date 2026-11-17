import path from 'node:path';
/**
 * Explicit user commit operation for git-review.
 *
 * Commits use the repository's normal hooks and GPG settings. The caller must
 * hold gitRepoWriteQueue for the repo root before invoking this module.
 */

import { GitRunError, runGit } from './gitRunner.js';
import type { ReviewScope, ReviewStatus } from './types.js';

const GIT_WRITE_MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export interface CommitStagedChangesOptions {
  includeUnstaged?: boolean;
}

export class GitReviewCommitError extends Error {
  readonly stderr?: string;

  constructor(message: string, stderr?: string) {
    super(message);
    this.name = 'GitReviewCommitError';
    this.stderr = stderr;
  }
}

function assertCanCommit(
  scope: ReviewScope,
  status: ReviewStatus,
  message: string,
  options: CommitStagedChangesOptions,
): string {
  if (scope.disabledReason || !scope.repoRoot) {
    throw new GitReviewCommitError(scope.disabledMessage ?? 'git review is unavailable');
  }
  if (message.trim() === '') throw new GitReviewCommitError('commit message is required');
  if (status.writeDisabledReasons.length > 0) {
    throw new GitReviewCommitError(`git commit is disabled: ${status.writeDisabledReasons.join(', ')}`);
  }
  if (options.includeUnstaged && !status.dirty) {
    throw new GitReviewCommitError('there are no changes to commit');
  }
  if (!options.includeUnstaged && status.stagedCount === 0) {
    throw new GitReviewCommitError('there are no staged changes to commit');
  }
  return scope.repoRoot;
}

/** 提交时暂存用的 pathspec：限定在 session workdir 内；workdir 即仓库根时取整个仓库。 */
function commitPathspec(scope: ReviewScope, repoRoot: string): string[] {
  const workdir = scope.workdir;
  if (!workdir) return [':/'];
  const rel = path.relative(repoRoot, workdir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [':/'];
  return [rel];
}

export async function commitStagedChanges(
  scope: ReviewScope,
  status: ReviewStatus,
  message: string,
  options: CommitStagedChangesOptions = {},
): Promise<{ commitOid: string; stdout: string; stderr: string }> {
  const repoRoot = assertCanCommit(scope, status, message, options);
  try {
    if (options.includeUnstaged) {
      // 只暂存「列表能看到的范围」：workdir 是仓库子目录时，用 `:/` 会把仓库其它目录的
      // 未暂存改动一起提交（评审 #10979 P1）。
      const scopedPaths = commitPathspec(scope, repoRoot);
      await runGit(['add', '-A', '--', ...scopedPaths], {
        cwd: repoRoot,
        timeoutMs: 120_000,
      });
    }
    const result = await runGit(['commit', '-F', '-'], {
      cwd: repoRoot,
      stdin: message,
      timeoutMs: 120_000,
      maxStdoutBytes: GIT_WRITE_MAX_STDOUT_BYTES,
    });
    const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
    return { commitOid: stdout.trim(), stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err instanceof GitRunError) {
      throw new GitReviewCommitError(err.stderr || err.message, err.stderr);
    }
    throw err;
  }
}
