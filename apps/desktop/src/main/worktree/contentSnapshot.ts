import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { gitExec, GitExecError } from './gitExec';
import type { WorktreeRecycleRecord } from './recycleJournal';

async function indexHash(worktreePath: string): Promise<string> {
  const { stdout } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
  return createHash('sha256').update(await fs.readFile(stdout.trim())).digest('hex');
}

/** Distinguish a deliberately detached HEAD from an unreadable symbolic ref. */
export async function readWorktreeHeadRef(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(['symbolic-ref', '--quiet', 'HEAD'], worktreePath);
    const ref = stdout.trim();
    if (!ref.startsWith('refs/heads/')) throw new Error('unsupported worktree HEAD ref');
    return ref;
  } catch (error) {
    if (error instanceof GitExecError && error.exitCode === 1) return null;
    throw error;
  }
}

export async function worktreeContentBaselineMatches(
  worktreePath: string,
  snapshot: NonNullable<WorktreeRecycleRecord['snapshot']>,
): Promise<boolean> {
  const { stdout } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
  return stdout.trim() === snapshot.head && await indexHash(worktreePath) === snapshot.indexHash
    && (snapshot.headRef === undefined || await readWorktreeHeadRef(worktreePath) === snapshot.headRef);
}

/** Staged content of the live index, read from a copy so the live index is never locked or rewritten. */
async function stagedTree(worktreePath: string): Promise<string | null> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-index-'));
  const index = path.join(temp, 'index');
  try {
    const { stdout: indexPath } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
    await fs.copyFile(indexPath.trim(), index);
    const { stdout } = await gitExec(['write-tree'], worktreePath, {
      extraEnv: { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout.trim();
  } catch (error) {
    // An index that no longer yields a tree (e.g. new merge conflicts) has changed.
    if (error instanceof GitExecError) return null;
    throw error;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/**
 * Same HEAD and staged content as the baseline. Unlike the byte hash above, this tolerates
 * stat-cache refreshes (`git status` from another task rewrites the index without changing it),
 * so a long snapshot of a repository in active use is not discarded for nothing.
 */
export async function worktreeStagedContentMatches(
  worktreePath: string,
  snapshot: NonNullable<WorktreeRecycleRecord['snapshot']>,
): Promise<boolean> {
  const { stdout } = await gitExec(['rev-parse', 'HEAD'], worktreePath);
  return stdout.trim() === snapshot.head
    && (snapshot.headRef === undefined || await readWorktreeHeadRef(worktreePath) === snapshot.headRef)
    && await stagedTree(worktreePath) === snapshot.indexTree;
}

/** HEAD or the index moved while a snapshot was being captured. */
export class WorktreeChangedDuringSnapshotError extends Error {
  constructor() {
    super('worktree HEAD or index changed during snapshot');
  }
}

/**
 * Snapshot the actual HEAD, index and file tree without stashing or changing the live checkout.
 * `stagedContentOnly` checks consistency like {@link worktreeStagedContentMatches}, for callers
 * that only need the captured content; the default byte comparison suits destructive recycling.
 */
export async function captureWorktreeContent(
  worktreePath: string,
  ref: string,
  { stagedContentOnly = false }: { stagedContentOnly?: boolean } = {},
): Promise<NonNullable<WorktreeRecycleRecord['snapshot']>> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-index-'));
  const index = path.join(temp, 'index');
  const options = { extraEnv: { GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: '0' } };
  try {
    const { stdout: headOutput } = await gitExec(['rev-parse', '--verify', 'HEAD^{commit}'], worktreePath);
    const head = headOutput.trim();
    const headRef = await readWorktreeHeadRef(worktreePath);
    const { stdout: indexPath } = await gitExec(['rev-parse', '--path-format=absolute', '--git-path', 'index'], worktreePath);
    await fs.copyFile(indexPath.trim(), index);
    const originalIndexHash = createHash('sha256').update(await fs.readFile(index)).digest('hex');
    const { stdout: staged } = await gitExec(['write-tree'], worktreePath, options);
    const indexTree = staged.trim();
    // Untracked/ignored bytes go exclusively to the encrypted recovery archive.
    await gitExec(['add', '--update', '--', '.'], worktreePath, options);
    const { stdout: contents } = await gitExec(['write-tree'], worktreePath, options);
    const tree = contents.trim();
    // Retain both trees through the snapshot ref, including staged-only bytes.
    const identity = {
      GIT_AUTHOR_NAME: 'Cindy', GIT_AUTHOR_EMAIL: 'worktree@localhost',
      GIT_COMMITTER_NAME: 'Cindy', GIT_COMMITTER_EMAIL: 'worktree@localhost',
    };
    const commitOptions = { extraEnv: identity };
    const { stdout: indexCommit } = await gitExec(
      ['commit-tree', indexTree, '-p', head, '-m', 'Worktree index recovery'], worktreePath, commitOptions,
    );
    const { stdout: commitOutput } = await gitExec(
      ['commit-tree', tree, '-p', head, '-p', indexCommit.trim(), '-m', 'Worktree content recovery'],
      worktreePath, commitOptions,
    );
    const commit = commitOutput.trim();
    await gitExec(['update-ref', ref, commit], worktreePath);
    const snapshot = { head, headRef, tree, indexTree, commit, ref, indexHash: originalIndexHash };
    const unchanged = stagedContentOnly
      ? await worktreeStagedContentMatches(worktreePath, snapshot)
      : await worktreeContentBaselineMatches(worktreePath, snapshot);
    if (!unchanged) throw new WorktreeChangedDuringSnapshotError();
    return snapshot;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
