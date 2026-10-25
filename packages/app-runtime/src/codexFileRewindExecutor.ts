import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommitMessage, type SnapshotMeta } from './snapshotTrailers.js';
import { enqueueGitRepoWrite } from './gitRepoWriteQueue.js';
import type { CodexRewindPlan } from './codexFileRewindPlanner.js';
import type {GitExecResult} from '@cindy/worktree-core/gitTypes';
 import type {GitExecError as GitError} from '@cindy/worktree-core/gitTypes';
 export class CodexFileRewindExecutionError extends Error {
 constructor(readonly code: 'REWIND_GIT_CONFLICT' | 'REWIND_GIT_FAILED', message: string, readonly conflictFiles?: string[]) { super(message); this.name = 'CodexFileRewindExecutionError'; }
}
 export interface CodexFileRewindExecutorHost {gitExec:CodexFileRewindExecutorDeps['gitExec'];getHead:CodexFileRewindExecutorDeps['getHead'];GitExecError:typeof GitError;}


export interface CodexFileRewindExecutionResult {
  repoRoot: string; rollbackId: string; protectRef: string; rollbackCommit: string | null; revertedCommits: string[]; skippedCommits: string[];
}

type CompletedCodexFileRewindExecutionResult = CodexFileRewindExecutionResult & { rollbackCommit: string };

interface CodexFileRewindExecutorDeps { gitExec: (args: readonly string[], cwd?: string) => Promise<GitExecResult>; getHead: (repoRoot: string) => Promise<string>; createRollbackId: () => string; }
export interface CodexFileRewindLockedRollbackHooks<T> {
  commitThreadRollback: (execution: CodexFileRewindExecutionResult | null) => Promise<T>;
  onCompensationError?: (error: unknown, execution: CompletedCodexFileRewindExecutionResult) => void;
}
export function createCodexFileRewindExecutor(host: CodexFileRewindExecutorHost) {
const {gitExec,GitExecError,getHead} = host;



const defaultDeps: CodexFileRewindExecutorDeps = { gitExec, getHead, createRollbackId: randomUUID };
const BLOCKED_GIT_STATE_MARKERS = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;

async function executeCodexFileRewindPlan(plan: CodexRewindPlan, deps: Partial<CodexFileRewindExecutorDeps> = {}): Promise<CodexFileRewindExecutionResult | null> {
  if (plan.mode !== 'file-rewind') return null;
  return enqueueGitRepoWrite(plan.repoRoot, () => executeCodexFileRewindPlanLocked(plan, deps));
}

async function executeCodexFileRewindPlanWithThreadRollback<T>(
  plan: CodexRewindPlan,
  sessionId: string,
  hooks: CodexFileRewindLockedRollbackHooks<T>,
  deps: Partial<CodexFileRewindExecutorDeps> = {},
): Promise<{ fileRewind: CodexFileRewindExecutionResult | null; threadRollback: T }> {
  if (plan.mode !== 'file-rewind') {
    return { fileRewind: null, threadRollback: await hooks.commitThreadRollback(null) };
  }

  return enqueueGitRepoWrite(plan.repoRoot, async () => {
    const fileRewind = await executeCodexFileRewindPlanLocked(plan, deps);
    try {
      return { fileRewind, threadRollback: await hooks.commitThreadRollback(fileRewind) };
    } catch (err) {
      if (fileRewind.rollbackCommit) {
        const completedExecution = { ...fileRewind, rollbackCommit: fileRewind.rollbackCommit };
        try {
          await compensateCodexFileRewindExecutionLocked(completedExecution, sessionId, deps);
        } catch (compErr) {
          hooks.onCompensationError?.(compErr, completedExecution);
        }
      }
      throw err;
    }
  });
}

async function executeCodexFileRewindPlanLocked(plan: Extract<CodexRewindPlan, { mode: 'file-rewind' }>, deps: Partial<CodexFileRewindExecutorDeps>): Promise<CodexFileRewindExecutionResult> {
  const d = { ...defaultDeps, ...deps };
  const rollbackId = d.createRollbackId();
  const protectRef = `refs/xdt/pre-rollback/${rollbackId}`;

  if (await d.getHead(plan.repoRoot) !== plan.currentHead) throw new CodexFileRewindExecutionError('REWIND_GIT_FAILED', 'Git HEAD 已变化，已中止 Codex 文件 rewind');
  await ensureCleanWorktree(plan.repoRoot, d);
  await d.gitExec(['update-ref', protectRef, 'HEAD'], plan.repoRoot);

  const applied = await applyProtectedReverts(plan.repoRoot, protectRef, plan.revertCommitsNewestFirst, 'Codex 文件 rewind 遇到 Git 冲突，已中止，当前工作区未改变', d);
  const revertedCommits = plan.revertCommitsNewestFirst.filter((commit) => !applied.skippedCommits.includes(commit));
  if (revertedCommits.length === 0 || !(await hasStagedChanges(plan.repoRoot, d))) {
    await abortAndDeleteProtectRef(plan.repoRoot, protectRef, d);
    return { repoRoot: plan.repoRoot, rollbackId, protectRef, rollbackCommit: null, revertedCommits: [], skippedCommits: applied.skippedCommits.length ? applied.skippedCommits : [...plan.revertCommitsNewestFirst] };
  }

  const rollbackCommit = await commitProtectedRewind(plan.repoRoot, 'Codex rewind files', { sessionId: plan.sessionId, kind: 'rollback', rollbackId, rollbackTarget: plan.targetMessageClientId, reverts: revertedCommits, protectRef, branch: plan.currentBranch }, protectRef, d);

  return { repoRoot: plan.repoRoot, rollbackId, protectRef, rollbackCommit, revertedCommits, skippedCommits: applied.skippedCommits };
}

async function compensateCodexFileRewindExecution(execution: CodexFileRewindExecutionResult | null, sessionId: string, deps: Partial<CodexFileRewindExecutorDeps> = {}): Promise<void> {
  if (!execution?.rollbackCommit) return;
  const completedExecution = { ...execution, rollbackCommit: execution.rollbackCommit };
  await enqueueGitRepoWrite(execution.repoRoot, () => compensateCodexFileRewindExecutionLocked(completedExecution, sessionId, deps));
}

async function compensateCodexFileRewindExecutionLocked(execution: CompletedCodexFileRewindExecutionResult, sessionId: string, deps: Partial<CodexFileRewindExecutorDeps>): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const rollbackId = d.createRollbackId();
  const protectRef = `refs/xdt/pre-undo-rollback/${rollbackId}`;

  await ensureCleanWorktree(execution.repoRoot, d);
  await d.gitExec(['update-ref', protectRef, 'HEAD'], execution.repoRoot);
  await applyProtectedReverts(execution.repoRoot, protectRef, [execution.rollbackCommit], 'Codex 文件 rewind 补偿遇到 Git 冲突，已中止', d);
  if (!(await hasStagedChanges(execution.repoRoot, d))) { await abortAndDeleteProtectRef(execution.repoRoot, protectRef, d); return; }

  await commitProtectedRewind(execution.repoRoot, 'Codex rewind compensation', { sessionId, kind: 'rollback-undo', rollbackId, rollbackTarget: execution.rollbackCommit, reverts: [execution.rollbackCommit], protectRef }, protectRef, d);
}

async function applyProtectedReverts(repoRoot: string, protectRef: string, commitsNewestFirst: readonly string[], conflictMessage: string, deps: CodexFileRewindExecutorDeps): Promise<{ skippedCommits: string[]; conflictFiles?: string[] }> {
  let applied: Awaited<ReturnType<typeof applyRevertsNoCommit>>;
  try { applied = await applyRevertsNoCommit(repoRoot, commitsNewestFirst, deps); } catch (err) { await abortAndDeleteProtectRef(repoRoot, protectRef, deps); throw err; }
  if (!applied.conflictFiles) return applied;
  await abortAndDeleteProtectRef(repoRoot, protectRef, deps);
  throw new CodexFileRewindExecutionError('REWIND_GIT_CONFLICT', conflictMessage, applied.conflictFiles);
}

async function applyRevertsNoCommit(repoRoot: string, commitsNewestFirst: readonly string[], deps: CodexFileRewindExecutorDeps): Promise<{ skippedCommits: string[]; conflictFiles?: string[] }> {
  const skippedCommits: string[] = [];
  for (const commit of commitsNewestFirst) {
    try {
      await deps.gitExec(['revert', '--no-commit', commit], repoRoot);
    } catch (err) {
      const conflictFiles = await safeListConflictFiles(repoRoot, deps);
      if (conflictFiles.length > 0 || isConflictError(err)) return { skippedCommits, conflictFiles };
      if (isEmptyRevertError(err)) {
        await deps.gitExec(['revert', '--quit'], repoRoot).catch(() => undefined); skippedCommits.push(commit); continue;
      }
      await abortRevert(repoRoot, deps);
      throw toRewindGitFailed(err);
    }
  }
  return { skippedCommits };
}

async function commitXdtRewind(repoRoot: string, label: string, meta: SnapshotMeta, deps: CodexFileRewindExecutorDeps): Promise<string> {
  await withDisabledHooks((hooksPath) => deps.gitExec(['-c', `core.hooksPath=${toGitConfigPath(hooksPath)}`, 'commit', '--no-verify', '--no-gpg-sign', '-m', buildCommitMessage(label, meta)], repoRoot));
  return deps.getHead(repoRoot);
}

async function withDisabledHooks<T>(fn: (hooksPath: string) => Promise<T>): Promise<T> {
  const hooksPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-rewind-hooks-'));
  try { return await fn(hooksPath); } finally { await fs.rm(hooksPath, { recursive: true, force: true }); }
}

function toGitConfigPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

async function commitProtectedRewind(repoRoot: string, label: string, meta: SnapshotMeta, protectRef: string, deps: CodexFileRewindExecutorDeps): Promise<string> {
  try { return await commitXdtRewind(repoRoot, label, meta, deps); } catch (err) { await abortAndDeleteProtectRef(repoRoot, protectRef, deps); throw toRewindGitFailed(err); }
}

async function abortAndDeleteProtectRef(repoRoot: string, protectRef: string, deps: CodexFileRewindExecutorDeps): Promise<void> {
  await abortRevert(repoRoot, deps); await resetToProtectRef(repoRoot, protectRef, deps); await deleteProtectRef(repoRoot, protectRef, deps);
}

async function abortRevert(repoRoot: string, deps: CodexFileRewindExecutorDeps): Promise<void> {
  await deps.gitExec(['revert', '--abort'], repoRoot).catch(() => undefined);
}

async function resetToProtectRef(repoRoot: string, protectRef: string, deps: CodexFileRewindExecutorDeps): Promise<void> {
  await deps.gitExec(['reset', '--hard', protectRef], repoRoot).catch(() => undefined);
}

async function deleteProtectRef(repoRoot: string, protectRef: string, deps: CodexFileRewindExecutorDeps): Promise<void> {
  await deps.gitExec(['update-ref', '-d', protectRef], repoRoot).catch(() => undefined);
}

async function ensureCleanWorktree(repoRoot: string, deps: CodexFileRewindExecutorDeps): Promise<void> {
  try {
    await ensureNoActiveGitOperation(repoRoot, deps);
    const { stdout } = await deps.gitExec(['status', '--porcelain=v1', '--untracked-files=no'], repoRoot);
    if (!stdout.trim()) return;
  } catch (err) { throw toRewindGitFailed(err); }
  throw new CodexFileRewindExecutionError('REWIND_GIT_FAILED', 'Codex 文件 rewind 需要干净的 Git 工作区，请先提交、stash 或撤销当前改动');
}

async function ensureNoActiveGitOperation(repoRoot: string, deps: CodexFileRewindExecutorDeps): Promise<void> {
  for (const marker of BLOCKED_GIT_STATE_MARKERS) {
    const markerPath = await resolveGitInternalPath(repoRoot, marker, deps);
    if (markerPath && (await pathExists(markerPath))) {
      throw new CodexFileRewindExecutionError('REWIND_GIT_FAILED', 'Codex 文件 rewind 需要 Git 仓库没有进行中的 merge/rebase/cherry-pick/revert，请先完成或中止当前 Git 操作');
    }
  }
}

async function resolveGitInternalPath(repoRoot: string, marker: string, deps: CodexFileRewindExecutorDeps): Promise<string | null> {
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

async function hasStagedChanges(repoRoot: string, deps: CodexFileRewindExecutorDeps): Promise<boolean> {
  try {
    await deps.gitExec(['diff', '--cached', '--quiet'], repoRoot); return false;
  } catch (err) {
    if (err instanceof GitExecError && err.exitCode === 1) return true;
    throw toRewindGitFailed(err);
  }
}

async function safeListConflictFiles(repoRoot: string, deps: CodexFileRewindExecutorDeps): Promise<string[]> {
  try {
    const { stdout } = await deps.gitExec(['diff', '--name-only', '--diff-filter=U'], repoRoot);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function isConflictError(err: unknown): boolean {
  if (!(err instanceof GitExecError)) return false;
  const text = `${err.stderr}\n${err.stdout}`;
  return /conflict|CONFLICT|could not revert|after resolving the conflicts/i.test(text);
}

function isEmptyRevertError(err: unknown): boolean {
  if (!(err instanceof GitExecError)) return false;
  const text = `${err.stderr}\n${err.stdout}`;
  return /nothing to commit|is empty|previous .* is now empty|empty commit set/i.test(text);
}

function toRewindGitFailed(err: unknown): CodexFileRewindExecutionError {
  if (err instanceof CodexFileRewindExecutionError) return err;
  return new CodexFileRewindExecutionError('REWIND_GIT_FAILED', err instanceof Error ? err.message : String(err));
}
return {
  executeCodexFileRewindPlan,
  executeCodexFileRewindPlanWithThreadRollback,
  compensateCodexFileRewindExecution
};
}
