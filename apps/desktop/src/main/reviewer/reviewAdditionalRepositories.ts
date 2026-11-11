import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';

import { readReviewBranchDiff } from '../git-review/ipc.js';
import { runGit } from '../git-review/gitRunner.js';
import { withSessionReviewWorkspace } from '../git-review/scopeResolver.js';
import type { TouchedDir } from '../git-context/sessionDirResolver.js';
import {
  loadReviewBranchEvidence,
  readReviewWorkspaceSnapshot,
  reviewBranchBaselineIsCurrent,
  reviewWorkspaceFingerprintIsCurrent,
} from './reviewEvidence.js';
import { repositoryHasChanges, type ReviewRepositoryEvidence } from './reviewPrompt.js';

const MAX_ADDITIONAL_REPOSITORIES = 4;

export interface LoadedReviewRepository extends ReviewRepositoryEvidence {
  fingerprint: string | null;
}

/** The repository root containing an existing local directory, or null. */
export async function resolveReviewRepoRoot(dir: string): Promise<string | null> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return null;
    const { stdout } = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    const root = stdout.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

export interface SkippedReviewRepository {
  root: string;
  /** limit: over the repository cap; unreadable: its Git evidence could not be read. */
  reason: 'limit' | 'unreadable';
}

export interface AdditionalReviewRepositories {
  repos: LoadedReviewRepository[];
  /** Coverage gaps the Reviewer and the user must be told about. */
  skipped: SkippedReviewRepository[];
  /** Task directories beyond the scan budget that were never resolved. */
  uncheckedDirs: number;
}

interface CandidateRoot {
  root: string;
  edited: boolean;
  firstSeenAt: number | null;
}

const MAX_RESOLVED_TASK_DIRS = 40;
const MAX_MTIME_PROBES = 200;
/** File and commit clocks may lag the recorded tool-use time slightly. */
const CLOCK_SKEW_MS = 2_000;

function workspaceEvidencePaths(repo: ReviewRepositoryEvidence): string[] {
  const workspace = repo.workspace;
  if (!workspace) return [];
  return [
    ...workspace.diffs.staged,
    ...workspace.diffs.unstaged,
    ...(workspace.diffs.capped?.staged?.files ?? []),
    ...(workspace.diffs.capped?.unstaged?.files ?? []),
  ].map((file) => file.path);
}

/**
 * Whether a repository the task only ran commands in changed while the task was
 * working there: an uncommitted file modified, or a commit made, after the task
 * first touched it. Unrelated edits that predate the task do not qualify.
 */
export async function reviewRepositoryChangedSince(
  repo: ReviewRepositoryEvidence,
  since: number | null,
): Promise<boolean> {
  if (since === null) return false;
  const threshold = since - CLOCK_SKEW_MS;
  for (const relativePath of workspaceEvidencePaths(repo).slice(0, MAX_MTIME_PROBES)) {
    const stat = await fs.stat(path.join(repo.root, relativePath)).catch(() => null);
    if (stat && stat.mtimeMs >= threshold) return true;
  }
  if (repo.branch) {
    try {
      const { stdout } = await runGit(['log', '-1', '--format=%ct', 'HEAD'], { cwd: repo.root });
      const committedAt = Number(stdout.trim()) * 1000;
      if (Number.isFinite(committedAt) && committedAt >= threshold) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Other repositories or worktrees the task changed besides the primary one,
 * newest first. A repository qualifies only with uncommitted work or branch
 * commits that the task can be credited with: it edited files there, or the
 * changes appeared after the task first worked there. A checkout the task merely
 * read must not pull someone else's edits into the review and its follow-up fix.
 * Each one is read through the same pinned-workspace path as the primary, so
 * redaction, caps and fingerprints are identical.
 */
export async function loadAdditionalReviewRepositories(input: {
  sourceSessionId: string;
  primaryRoot: string | null;
  touchedDirs: readonly TouchedDir[];
  resolveRepoRoot?: (dir: string) => Promise<string | null>;
  changedSince?: (repo: ReviewRepositoryEvidence, since: number | null) => Promise<boolean>;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}): Promise<AdditionalReviewRepositories> {
  const resolveRoot = input.resolveRepoRoot ?? resolveReviewRepoRoot;
  const changedSince = input.changedSince ?? reviewRepositoryChangedSince;
  const primary = input.primaryRoot ? path.resolve(input.primaryRoot) : null;
  const candidates = new Map<string, CandidateRoot>();
  const usableDirs = input.touchedDirs.filter((touched) => !isReviewSensitiveCredentialPath(touched.dir));
  for (const touched of usableDirs.slice(0, MAX_RESOLVED_TASK_DIRS)) {
    const root = await resolveRoot(touched.dir);
    if (!root || root === primary || isReviewSensitiveCredentialPath(root)) continue;
    const existing = candidates.get(root);
    if (!existing) {
      candidates.set(root, { root, edited: touched.edited, firstSeenAt: touched.firstSeenAt });
      continue;
    }
    existing.edited ||= touched.edited;
    if (
      touched.firstSeenAt !== null &&
      (existing.firstSeenAt === null || touched.firstSeenAt < existing.firstSeenAt)
    ) {
      existing.firstSeenAt = touched.firstSeenAt;
    }
  }

  const repos: LoadedReviewRepository[] = [];
  const skipped: SkippedReviewRepository[] = [];
  for (const candidate of candidates.values()) {
    if (repos.length >= MAX_ADDITIONAL_REPOSITORIES) {
      skipped.push({ root: candidate.root, reason: 'limit' });
      continue;
    }
    try {
      const repo = await withSessionReviewWorkspace(input.sourceSessionId, candidate.root, async () => {
        const snapshot = await readReviewWorkspaceSnapshot(input.sourceSessionId);
        const workspace = snapshot?.workspace ?? null;
        if (!snapshot || !workspace || workspace.disabledReason) return null;
        const branchEvidence = await loadReviewBranchEvidence(
          input.sourceSessionId,
          readReviewBranchDiff,
        );
        const loaded: LoadedReviewRepository = {
          root: candidate.root,
          workspace,
          branch: branchEvidence.branch,
          fingerprint: snapshot.fingerprint,
          ...(branchEvidence.unavailableReason
            ? { branchUnavailableReason: branchEvidence.unavailableReason }
            : {}),
        };
        return loaded;
      });
      if (!repo || !repositoryHasChanges(repo)) continue;
      if (!candidate.edited && !(await changedSince(repo, candidate.firstSeenAt))) continue;
      repos.push(repo);
    } catch (error) {
      // Additional repositories widen coverage; one unreadable checkout must not
      // abort the review of the primary deliverable, but it is a stated gap.
      skipped.push({ root: candidate.root, reason: 'unreadable' });
      input.warn?.('review additional repository skipped', {
        root: candidate.root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    repos,
    skipped,
    uncheckedDirs: Math.max(0, usableDirs.length - MAX_RESOLVED_TASK_DIRS),
  };
}

/** Freshness for additional repositories, with the same rules as the primary. */
export async function additionalReviewRepositoriesAreCurrent(
  sourceSessionId: string,
  repos: readonly LoadedReviewRepository[],
): Promise<boolean> {
  for (const repo of repos) {
    const current = await withSessionReviewWorkspace(sourceSessionId, repo.root, async () =>
      (await reviewWorkspaceFingerprintIsCurrent(sourceSessionId, repo.fingerprint)) &&
      (await reviewBranchBaselineIsCurrent(sourceSessionId, repo.branch)),
    ).catch(() => false);
    if (!current) return false;
  }
  return true;
}
