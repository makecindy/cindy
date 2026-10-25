/**
 * Worktree 池化复用：为 scheduler 场景缓存已创建的 ephemeral worktree，
 * 避免每次 session 都走完整的 createWorktree 10 步 pipeline。
 *
 * 池按 baseRepo 索引，容量 1（scheduler 串行，不需要更多）。
 * store（electron-store JSON）持久化 meta，app 重启时 recoverPool() 恢复池状态。
 *
 * 核心原则：pool 只持有 clean worktree，dirty worktree 永远不自动删除。
 * 淘汰策略：不使用 idle timeout，改为全局数量上限（MAX_WORKTREES）按 createdAt 淘汰 clean 条目。
 */

import { checkpointWorktreeForReuse, recycleManagedWorktree } from './managedRecycle';
import { withWorktreeResourceLock } from './resourceLock';
import { readRecycleRecord } from './recycleJournal';
import { restoreRecordedWorktree } from './restoreRecovery';
import { withLegacyWorktreeRuntimeGuard } from './legacyRuntimeGuard';

import { gitExec } from './gitExec';

import { isWorktreeDirty } from './dirty';
import { copyClaudeSiviDirs } from './WorktreeManager';
import * as WorktreeManager from './WorktreeManager';
import { applyWorktreeIncludeFile } from './includePatternsEngine';
import { hasLiveSessionReference, loadLiveSessionPathKeys } from './liveSessionRefs';
import { getBranchName } from './nameGenerator';

import * as store from './worktreeStore';
import { createLogger } from '../logger';

const log = createLogger('WorktreePool');

import { createWorktreePool } from '@cindy/worktree-core/pool';
export const { acquireWorktree, releaseWorktree, drainOne, parkAll, recoverPool } =
  createWorktreePool({
    checkpointWorktreeForReuse,
    recycleManagedWorktree,
    withWorktreeResourceLock,
    readRecycleRecord,
    restoreRecordedWorktree,
    withLegacyWorktreeRuntimeGuard,
    gitExec,
    isWorktreeDirty,
    copyClaudeSiviDirs,
    WorktreeManager,
    applyWorktreeIncludeFile,
    hasLiveSessionReference,
    loadLiveSessionPathKeys,
    getBranchName,
    store,
    log,
  });
