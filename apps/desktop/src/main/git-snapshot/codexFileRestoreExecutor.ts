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

  let preRollback: ShadowSavepointResult;
  try {
    // Full worktree snapshot first: every byte the restore may overwrite is
    // reachable from the chain before any file changes.
    preRollback = await d.createShadowSavepoint(plan.repoRoot, {
      sessionId: plan.sessionId,
      label: '回退前的工作区快照',
      meta: {
        kind: 'pre-rollback',
        rollbackId,
        rollbackTarget: plan.targetMessageClientId,
      },
    });
  } catch (err) {
    throw toRewindGitFailed(err);
  }
  const preRollbackCommit = preRollback.commit;
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

  // Affected files whose *current* content the safety filter kept out of the
  // pre-rollback snapshot (sensitive, oversized, nested repo …) would be
  // overwritten or deleted with no way to compensate — the snapshot simply
  // does not hold their bytes. Abort before touching anything. Only paths
  // that still exist as regular files carry bytes at risk: a skipped entry
  // for an already-deleted path (e.g. the file side of a D/F conversion) has
  // nothing to protect.
  const unprotectedSkips = new Set(preRollback.skippedFiles.map((file) => file.path));
  const unprotected: string[] = [];
  for (const p of affectedPaths) {
    if (!unprotectedSkips.has(p)) continue;
    const abs = resolveSnapshotGitPath(plan.repoRoot, p);
    if (!abs) continue;
    const stats = await fs.lstat(abs).catch(() => null);
    if (stats && !stats.isDirectory()) unprotected.push(p);
  }
  if (unprotected.length > 0) {
    throw new CodexFileRewindExecutionError(
      'REWIND_GIT_FAILED',
      `文件回退已中止:${unprotected.slice(0, 5).join('、')}${unprotected.length > 5 ? ' 等' : ''} 当前处于安全过滤范围(敏感路径/超大文件/嵌套仓库),回退前快照无法完整保护其内容,请先手动备份或移出这些文件后重试`,
    );
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

  // ── 阶段一:全量校验,零改动 ──
  // 不变量:回退报成功 ⇒ 受影响文件全部回到目标状态。任何围栏命中都必须
  // 在动第一个文件之前中止(REWIND_GIT_FAILED),而不是跳过后报成功——
  // 否则对话被裁掉、文件却没回去,形成静默的不一致。
  const repoReal = await fs.realpath(repoRoot);
  const affectedSet = new Set(paths);

  const deletions: Array<{ filePath: string; realAbs: string }> = [];
  for (const filePath of toDelete) {
    const abs = resolveSnapshotGitPath(repoRoot, filePath);
    if (!abs) continue;
    const resolved = await resolveRealPathInsideRepo(repoReal, abs);
    if (resolved.kind === 'missing') continue; // 目标本就不存在,删除是 no-op
    if (resolved.kind === 'escaped') {
      throw fenceAbort(filePath, '待删除路径的真实父目录已在仓库外(符号链接)');
    }
    deletions.push({ filePath, realAbs: resolved.realAbs });
  }

  // git restore 会写穿指向仓库外的符号链接父目录(创建前导目录时 stat 跟随
  // 链接):最近存在祖先的真实路径必须仍在仓库内;缺失祖先向上追溯,保住
  // 「恢复进尚不存在的目录」的合法场景。
  const collisionsToClear: Array<{ filePath: string; realAbs: string }> = [];
  for (const filePath of toRestore) {
    const abs = resolveSnapshotGitPath(repoRoot, filePath);
    if (!abs) continue;
    if (await nearestExistingAncestorEscapes(repoReal, abs)) {
      throw fenceAbort(filePath, '恢复目标的真实父目录已在仓库外(符号链接)');
    }
    const stats = await fs.lstat(abs).catch(() => null);
    if (!stats?.isDirectory()) continue;
    const resolved = await resolveRealPathInsideRepo(repoReal, abs);
    if (resolved.kind !== 'ok') {
      throw fenceAbort(filePath, '碰撞目录的真实路径已离开仓库');
    }
    // 碰撞目录里可能有用户在保存点之后手工放入、未被任何 turn 记录的文件:
    // 它们不在受影响集合里,成功路径不会恢复、补偿也不覆盖。发现即中止,
    // 交用户先处理该目录。
    const outOfScope = await listDescendantsOutsideScope(resolved.realAbs, filePath, affectedSet);
    if (outOfScope.length > 0) {
      throw new CodexFileRewindExecutionError(
        'REWIND_GIT_FAILED',
        `文件回退已中止:${filePath} 现在是目录,且包含本次回退范围之外的文件(如 ${outOfScope.slice(0, 3).join('、')}),请先移出或删除这些文件后重试`,
      );
    }
    collisionsToClear.push({ filePath, realAbs: resolved.realAbs });
  }

  // ── 阶段二:执行 ──
  // Deletions first: a turn that converted a directory into a file makes the
  // reverse diff delete the file (`swap`) and restore its former descendants
  // (`swap/child.txt`); deleting after the restore would wipe what was just
  // recreated.
  for (const { realAbs } of deletions) {
    // recursive: the path may be a directory in the worktree (e.g. a file →
    // directory conversion the target tree does not have). ENOTDIR means a
    // parent segment is a file again, so the old nested path is already gone.
    await fs.rm(realAbs, { recursive: true, force: true }).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw err;
    });
    await pruneEmptyParents(repoReal, realAbs);
  }

  if (toRestore.length > 0) {
    // A turn may have replaced a file with a directory; git restore cannot
    // write a blob over an existing directory, so clear such (validated)
    // collisions first — contents are recoverable from the pre-rollback
    // savepoint.
    for (const { realAbs } of collisionsToClear) {
      await fs.rm(realAbs, { recursive: true, force: true });
    }
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

  return { restored: toRestore, deleted: toDelete };
}

function fenceAbort(filePath: string, reason: string): CodexFileRewindExecutionError {
  return new CodexFileRewindExecutionError(
    'REWIND_GIT_FAILED',
    `文件回退已中止:${filePath} 未通过安全围栏(${reason}),为避免对话与文件不一致,本次未修改任何文件,请先处理该路径后重试`,
  );
}

/**
 * True when the closest existing ancestor of the (lexically in-repo) path
 * resolves outside the repository — i.e. a parent segment is currently a
 * symlink escaping the repo. Missing ancestors are walked upward so that
 * restoring into not-yet-existing directories stays allowed.
 */
async function nearestExistingAncestorEscapes(
  repoReal: string,
  absPath: string,
): Promise<boolean> {
  let dir = path.dirname(absPath);
  for (;;) {
    const real = await fs.realpath(dir).catch(() => null);
    if (real) {
      return real !== repoReal && !real.startsWith(repoReal + path.sep);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
}

/**
 * Lists files under a collision directory whose repo paths are NOT part of
 * the restore scope. Symlink entries are treated as files (never followed).
 */
async function listDescendantsOutsideScope(
  realDirPath: string,
  gitDirPath: string,
  affectedSet: ReadonlySet<string>,
): Promise<string[]> {
  const outOfScope: string[] = [];
  const stack: Array<{ realPath: string; gitPath: string }> = [
    { realPath: realDirPath, gitPath: gitDirPath },
  ];
  while (stack.length > 0) {
    const { realPath, gitPath } = stack.pop() as { realPath: string; gitPath: string };
    const entries = await fs.readdir(realPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childGitPath = `${gitPath}/${entry.name}`;
      if (entry.isDirectory()) {
        stack.push({ realPath: path.join(realPath, entry.name), gitPath: childGitPath });
        continue;
      }
      if (!affectedSet.has(childGitPath)) outOfScope.push(childGitPath);
    }
  }
  return outOfScope.sort();
}

type RealPathResolution =
  | { kind: 'ok'; realAbs: string }
  | { kind: 'missing' }
  | { kind: 'escaped' };

/**
 * Resolves the mutation target with intermediate symlinks flattened. The
 * final component itself is never followed (fs.rm removes a symlink, not
 * its target), so only the parent needs the realpath check. `missing` means
 * the parent (hence the target) does not exist; `escaped` means the real
 * parent directory left the repository — callers must abort, not skip.
 */
async function resolveRealPathInsideRepo(
  repoReal: string,
  absPath: string,
): Promise<RealPathResolution> {
  const parentReal = await fs.realpath(path.dirname(absPath)).catch(() => null);
  if (!parentReal) return { kind: 'missing' };
  if (parentReal !== repoReal && !parentReal.startsWith(repoReal + path.sep)) {
    return { kind: 'escaped' };
  }
  return { kind: 'ok', realAbs: path.join(parentReal, path.basename(absPath)) };
}

/** Removes now-empty real parent directories left behind by file deletion. */
async function pruneEmptyParents(repoReal: string, realFilePath: string): Promise<void> {
  let dir = path.dirname(realFilePath);
  while (dir !== repoReal && dir.startsWith(repoReal + path.sep)) {
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
