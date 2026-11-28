/**
 * Fast-forward-only pull for git-review.
 *
 * `--ff-only` keeps the operation reversible from the user's point of view:
 * when local and remote diverged we surface the error and let the user decide,
 * instead of silently creating a merge commit or rebasing their work.
 */

import { GitRunError, runGit } from './gitRunner.js';
import type { ReviewScope, ReviewStatus } from './types.js';

const PULL_TIMEOUT_MS = 60_000;

export class GitReviewPullError extends Error {
  readonly stderr?: string;

  constructor(message: string, stderr?: string) {
    super(message);
    this.name = 'GitReviewPullError';
    this.stderr = stderr;
  }
}

function assertCanPull(scope: ReviewScope, status: ReviewStatus): string {
  if (scope.disabledReason || !scope.repoRoot) {
    throw new GitReviewPullError(scope.disabledMessage ?? 'git review is unavailable');
  }
  if (scope.isDetached) throw new GitReviewPullError('cannot pull on a detached HEAD');
  if (scope.isUnborn) throw new GitReviewPullError('current branch has no commits yet');
  if (!scope.aheadBehind.upstream) {
    throw new GitReviewPullError('current branch has no upstream; set one before pulling');
  }
  if (status.writeDisabledReasons.length > 0) {
    throw new GitReviewPullError(
      `git pull is disabled: ${status.writeDisabledReasons.join(', ')}`,
    );
  }
  return scope.repoRoot;
}

export async function pullBranch(
  scope: ReviewScope,
  status: ReviewStatus,
): Promise<{ stdout: string; stderr: string }> {
  const repoRoot = assertCanPull(scope, status);
  try {
    const result = await runGit(['pull', '--ff-only'], {
      cwd: repoRoot,
      timeoutMs: PULL_TIMEOUT_MS,
      killProcessGroup: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    if (err instanceof GitRunError) {
      throw new GitReviewPullError(err.stderr || err.message, err.stderr);
    }
    throw err;
  }
}
