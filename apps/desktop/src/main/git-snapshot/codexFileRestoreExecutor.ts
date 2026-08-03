/**
 * Executes shadow savepoint file-restore plans.
 *
 * Unlike the legacy revert executor, this path never commits to the user's
 * branch and never requires a clean worktree: affected files are rewritten in
 * place to the target turn-start tree, a pre-rollback savepoint on the hidden
 * chain provides the compensation anchor, and the user's index stays intact.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger';
import { gitExec, GitExecError, type GitExecResult } from '../worktree/gitExec';
import { CodexFileRewindExecutionError } from './codexFileRewindExecutor';
import type { CodexRewindPlan, CodexFileRestorePlan } from './codexFileRewindPlanner';
import { enqueueGitRepoWrite } from './gitRepoWriteQueue';
import {
  chunkPathspecArgs,
  createShadowMarker,
  createShadowSavepoint,
  withPathspecFile,
  writeWorktreeTreeForPaths,
  type CreateShadowMarkerInput,
  type CreateShadowSavepointInput,
  type ShadowSavepointResult,
} from './gitSnapshotService';
import { resolveSnapshotGitPath } from './snapshotFileFilter';

const log = createLogger('git-snapshot');

export interface CodexFileRestoreExecutionResult {
  repoRoot: string;
  rollbackId: string;
  /** Full worktree savepoint taken right before the restore, on the chain. */
  preRollbackCommit: string;
  /** Chain marker recording the rollback, or null when nothing changed. */
  rollbackCommit: string | null;
  /** Paths rewritten to the baseline tree content. */
  restoredFiles: string[];
  /** Paths deleted because the baseline tree does not contain them. */
  deletedFiles: string[];
  /** Union of paths touched by the undone turns; compensation scope. */
  affectedPaths: string[];
}

interface CodexFileRestoreExecutorDeps {
  gitExec: (args: readonly string[], cwd?: string) => Promise<GitExecResult>;
  createRollbackId: () => string;
  createShadowSavepoint: (
    repoPath: string,
    input: CreateShadowSavepointInput,
  ) => Promise<ShadowSavepointResult>;
  createShadowMarker: (
    repoPath: string,
    input: CreateShadowMarkerInput,
  ) => Promise<string | null>;
  writeWorktreeTree: (repoPath: string, pathspecs: readonly string[]) => Promise<string>;
}

export interface CodexFileRestoreLockedRollbackHooks<T> {
  commitThreadRollback: (execution: CodexFileRestoreExecutionResult | null) => Promise<T>;
  onCompensationError?: (error: unknown, execution: CodexFileRestoreExecutionResult) => void;
}

const defaultDeps: CodexFileRestoreExecutorDeps = {
  gitExec,
  createRollbackId: randomUUID,
  createShadowSavepoint,
  createShadowMarker,
  writeWorktreeTree: writeWorktreeTreeForPaths,
};

const BLOCKED_GIT_STATE_MARKERS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
] as const;

export async function executeCodexFileRestorePlan(
  plan: CodexRewindPlan,
  deps: Partial<CodexFileRestoreExecutorDeps> = {},
): Promise<CodexFileRestoreExecutionResult | null> {
  if (plan.mode !== 'file-restore') return null;
  return enqueueGitRepoWrite(plan.repoRoot, () => executeCodexFileRestorePlanLocked(plan, deps));
}

export async function executeCodexFileRestorePlanWithThreadRollback<T>(
  plan: CodexRewindPlan,
  sessionId: string,
  hooks: CodexFileRestoreLockedRollbackHooks<T>,
  deps: Partial<CodexFileRestoreExecutorDeps> = {},
): Promise<{ fileRestore: CodexFileRestoreExecutionResult | null; threadRollback: T }> {
  if (plan.mode !== 'file-restore') {
    return { fileRestore: null, threadRollback: await hooks.commitThreadRollback(null) };
  }

  return enqueueGitRepoWrite(plan.repoRoot, async () => {
    const fileRestore = await executeCodexFileRestorePlanLocked(plan, deps);
    try {
      return { fileRestore, threadRollback: await hooks.commitThreadRollback(fileRestore) };
    } catch (err) {
      if (fileRestore.restoredFiles.length > 0 || fileRestore.deletedFiles.length > 0) {
        try {
          await compensateCodexFileRestoreExecutionLocked(fileRestore, sessionId, deps);
        } catch (compErr) {
          hooks.onCompensationError?.(compErr, fileRestore);
        }
      }
      throw err;
    }
  });
}

export async function compensateCodexFileRestoreExecution(
  execution: CodexFileRestoreExecutionResult | null,
  sessionId: string,
  deps: Partial<CodexFileRestoreExecutorDeps> = {},
): Promise<void> {
  if (!execution) return;
  if (execution.restoredFiles.length === 0 && execution.deletedFiles.length === 0) return;
  await enqueueGitRepoWrite(execution.repoRoot, () =>
    compensateCodexFileRestoreExecutionLocked(execution, sessionId, deps),
  );
}

async function executeCodexFileRestorePlanLocked(
  plan: CodexFileRestorePlan,
  deps: Partial<CodexFileRestoreExecutorDeps>,
): Promise<CodexFileRestoreExecutionResult> {
  const d = { ...defaultDeps, ...deps };
  const rollbackId = d.createRollbackId();

  await ensureNoActiveGitOperation(plan.repoRoot, d);

  let preRollbackCommit: string | null;
  try {
    // Full worktree snapshot first: every byte the restore may overwrite is
    // reachable from the chain before any file changes.
    ({ commit: preRollbackCommit } = await d.createShadowSavepoint(plan.repoRoot, {
      sessionId: plan.sessionId,
      label: '回退前的工作区快照',
      meta: {
        kind: 'pre-rollback',
        rollbackId,
        rollbackTarget: plan.targetMessageClientId,
      },
    }));
  } catch (err) {
    throw toRewindGitFailed(err);
  }
  if (!preRollbackCommit) {
    throw new CodexFileRewindExecutionError(
      'REWIND_GIT_FAILED',
      '回退前快照未产生提交，已中止文件回退',
    );
  }

  const affectedPaths = await collectAffectedPaths(plan, d);
  const base: CodexFileRestoreExecutionResult = {
    repoRoot: plan.repoRoot,
    rollbackId,
    preRollbackCommit,
    rollbackCommit: null,
    restoredFiles: [],
    deletedFiles: [],
    affectedPaths,
  };
  if (affectedPaths.length === 0) {
    return base;
  }

  let applied: WorktreeApplyResult;
  try {
    applied = await makeWorktreeMatchCommit(plan.repoRoot, plan.baselineCommit, affectedPaths, d);
  } catch (err) {
    // Best-effort self-heal: put the affected files back to the pre-rollback
    // state so a partial apply never leaves a half-restored worktree.
    await makeWorktreeMatchCommit(plan.repoRoot, preRollbackCommit, affectedPaths, d).catch(
      (healErr) => {
        log.warn('[file-restore] self-heal after failed restore also failed', {
          repoRoot: plan.repoRoot,
          rollbackId,
          error: healErr instanceof Error ? healErr.message : String(healErr),
        });
      },
    );
    throw toRewindGitFailed(err);
  }

  if (applied.restored.length === 0 && applied.deleted.length === 0) {
    return base;
  }

  // The marker is bookkeeping only; its failure must not undo a successful
  // restore. Compensation is keyed on restored/deleted files, not on it.
  const rollbackCommit = await d
    .createShadowMarker(plan.repoRoot, {
      sessionId: plan.sessionId,
      label: 'Codex rewind files',
      meta: {
        kind: 'rollback',
        rollbackId,
        rollbackTarget: plan.targetMessageClientId,
        reverts: plan.restoreCommitsNewestFirst.map((entry) => entry.commit),
        preRollbackCommit,
      },
    })
    .catch((err) => {
      log.warn('[file-restore] rollback marker failed (restore already applied)', {
        repoRoot: plan.repoRoot,
        rollbackId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

  return {
    ...base,
    rollbackCommit,
    restoredFiles: applied.restored,
    deletedFiles: applied.deleted,
  };
}

async function compensateCodexFileRestoreExecutionLocked(
  execution: CodexFileRestoreExecutionResult,
  sessionId: string,
  deps: Partial<CodexFileRestoreExecutorDeps>,
): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  await ensureNoActiveGitOperation(execution.repoRoot, d);
  try {
    await makeWorktreeMatchCommit(
      execution.repoRoot,
      execution.preRollbackCommit,
      execution.affectedPaths,
      d,
    );
  } catch (err) {
    throw toRewindGitFailed(err);
  }
  await d
    .createShadowMarker(execution.repoRoot, {
      sessionId,
      label: 'Codex rewind compensation',
      meta: {
        kind: 'rollback-undo',
        rollbackId: d.createRollbackId(),
        rollbackTarget: execution.preRollbackCommit,
        ...(execution.rollbackCommit ? { reverts: [execution.rollbackCommit] } : {}),
        preRollbackCommit: execution.preRollbackCommit,
      },
    })
    .catch((err) => {
      log.warn('[file-restore] compensation marker failed (files already recovered)', {
        repoRoot: execution.repoRoot,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
}

/** Union of files each undone turn touched (turn-start → after-edit diff). */
async function collectAffectedPaths(
  plan: CodexFileRestorePlan,
  deps: CodexFileRestoreExecutorDeps,
): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of plan.restoreCommitsNewestFirst) {
    let stdout: string;
    try {
      ({ stdout } = await deps.gitExec(
        ['diff', '--name-only', '--no-renames', '-z', entry.baselineCommit, entry.commit],
        plan.repoRoot,
      ));
    } catch (err) {
      throw toRewindGitFailed(err);
    }
    for (const rawPath of stdout.split('\0')) {
      if (!rawPath || seen.has(rawPath)) continue;
      seen.add(rawPath);
      out.push(rawPath);
    }
  }
  return out;
}

interface WorktreeApplyResult {
  restored: string[];
  deleted: string[];
}

/**
 * Rewrites the worktree so the given paths match the target commit's tree:
 * differing/missing files are checked out from the target, files absent from
 * the target are removed. The user's index is never touched (`git restore
 * --worktree` + direct fs deletion), so `git status` keeps telling the truth.
 */
async function makeWorktreeMatchCommit(
  repoRoot: string,
  targetCommit: string,
  paths: readonly string[],
  deps: CodexFileRestoreExecutorDeps,
): Promise<WorktreeApplyResult> {
  const pathspecs = paths.map((p) => `:(literal)${p}`);
  const worktreeTree = await deps.writeWorktreeTree(repoRoot, paths);

  const toRestore: string[] = [];
  const toDelete: string[] = [];
  for (const chunk of chunkPathspecArgs(pathspecs)) {
    const { stdout } = await deps.gitExec(
      [
        'diff',
        '--name-status',
        '--no-renames',
        '-z',
        worktreeTree,
        targetCommit,
        '--',
        ...chunk,
      ],
      repoRoot,
    );
    const tokens = stdout.split('\0');
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const status = tokens[i];
      const filePath = tokens[i + 1];
      if (!status || !filePath) continue;
      // Direction is current worktree → target: D means the target tree does
      // not have the file, everything else means it must match the target.
      if (status.startsWith('D')) toDelete.push(filePath);
      else toRestore.push(filePath);
    }
  }

  if (toRestore.length > 0) {
    await withPathspecFile(
      toRestore.map((p) => `:(literal)${p}`),
      (pathspecFile) =>
        deps.gitExec(
          [
            'restore',
            `--source=${targetCommit}`,
            '--worktree',
            '--pathspec-from-file',
            pathspecFile,
            '--pathspec-file-nul',
          ],
          repoRoot,
        ),
    );
  }
  for (const filePath of toDelete) {
    const abs = resolveSnapshotGitPath(repoRoot, filePath);
    if (!abs) continue;
    await fs.rm(abs, { force: true });
    await pruneEmptyParents(repoRoot, abs);
  }

  return { restored: toRestore, deleted: toDelete };
}

/** Removes now-empty parent directories left behind by file deletion. */
async function pruneEmptyParents(repoRoot: string, absFilePath: string): Promise<void> {
  const root = path.resolve(repoRoot);
  let dir = path.dirname(absFilePath);
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

async function ensureNoActiveGitOperation(
  repoRoot: string,
  deps: CodexFileRestoreExecutorDeps,
): Promise<void> {
  for (const marker of BLOCKED_GIT_STATE_MARKERS) {
    const markerPath = await resolveGitInternalPath(repoRoot, marker, deps);
    if (markerPath && (await pathExists(markerPath))) {
      throw new CodexFileRewindExecutionError(
        'REWIND_GIT_FAILED',
        '文件回退需要 Git 仓库没有进行中的 merge/rebase/cherry-pick/revert，请先完成或中止当前 Git 操作',
      );
    }
  }
}

async function resolveGitInternalPath(
  repoRoot: string,
  marker: string,
  deps: CodexFileRestoreExecutorDeps,
): Promise<string | null> {
  const { stdout } = await deps.gitExec(['rev-parse', '--git-path', marker], repoRoot);
  const gitPath = stdout.trim();
  if (!gitPath) return null;
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then(
    () => true,
    () => false,
  );
}

function toRewindGitFailed(err: unknown): CodexFileRewindExecutionError {
  if (err instanceof CodexFileRewindExecutionError) return err;
  if (err instanceof GitExecError) {
    return new CodexFileRewindExecutionError('REWIND_GIT_FAILED', err.message);
  }
  return new CodexFileRewindExecutionError(
    'REWIND_GIT_FAILED',
    err instanceof Error ? err.message : String(err),
  );
}
