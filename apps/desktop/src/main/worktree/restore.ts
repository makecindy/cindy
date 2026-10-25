/**
 * worktree 恢复（P1，对齐 Codex Desktop 的 snapshot-restore 思路）：
 * 会话的 worktree 被回收后（删除/归档/历史误删），从保留的 `cindy/<name>`
 * 或历史 `xdt/<name>` 分支重建
 * worktree，并把回收时留下的内容快照（refs/xdt/snapshots/<sessionId>，见 dirty.ts）
 * apply 回去，一键恢复到回收前的状态。
 *
 * 数据来源：sessions.worktree_path（回收时刻意不清，见 worktreeStore.del 注释）。
 * 路径必须能解析为 `<baseRepo>/.cindy-worktrees/<name>` 或历史
 * `<baseRepo>/.xdt-worktrees/<name>` 托管形态，其它一律按 no-worktree
 * 处理——绝不对非托管路径做 git 写操作。
 */

import { eq, ne } from 'drizzle-orm';

import {
  clearSnapshotRef,
  getRestorableAutoStashSha,
  getRestorableSnapshotSha,
  markSnapshotConsumed,
} from './dirty';
import { readAttachedWorktreeBranch } from './attachedBranch';
import { gitExec, GitExecError } from './gitExec';
import { applyWorktreeIncludeFile } from './includePatternsEngine';

import {
  getWorktreeRestoreMutation,
  getWorktreeRestoreMutationVersion,
  withWorktreeRestoreMutation,
} from './restoreLock';
import { copyClaudeSiviDirs } from './WorktreeManager';
import { restoreRecordedWorktree } from './restoreRecovery';
import { readRecycleRecord, worktreeGeneration } from './recycleJournal';
import { withWorktreeResourceLock } from './resourceLock';
import * as store from './worktreeStore';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';

import { createWorktreeRestore } from '@cindy/worktree-core/restore';
export type {
  WorktreeRestoreResult,
  WorktreeRestoreStatus,
  ManagedWorktreeReadiness,
} from '@cindy/worktree-core/restore';

async function readSessionWorktreeBinding(
  sessionId: string,
): Promise<{ workingDir: string | null; worktreePath: string | null } | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      workingDir: sessions.workingDir,
      worktreePath: sessions.worktreePath,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return rows[0] ?? null;
}

async function readWorktreeOwnerRows() {
  const db = getDbClient().drizzle;
  return db
    .select({
      id: sessions.id,
      worktreePath: sessions.worktreePath,
      status: sessions.status,
    })
    .from(sessions)
    .where(ne(sessions.status, 'deleted'));
}
const log = createLogger('worktreeRestore');
export const {
  getWorktreeRestoreStatus,
  restoreWorktreeForSession,
  getManagedWorktreeReadinessForSession,
  restoreMissingManagedWorktreeForSession,
} = createWorktreeRestore({
  getWorktreeRestoreMutation,
  getWorktreeRestoreMutationVersion,
  withWorktreeRestoreMutation,
  clearSnapshotRef,
  getRestorableAutoStashSha,
  getRestorableSnapshotSha,
  markSnapshotConsumed,
  readAttachedWorktreeBranch,
  gitExec,
  GitExecError,
  applyWorktreeIncludeFile,
  copyClaudeSiviDirs,
  restoreRecordedWorktree,
  readRecycleRecord,
  worktreeGeneration,
  withWorktreeResourceLock,
  store,
  log,
  readSessionWorktreeBinding,
  readWorktreeOwnerRows,
});
