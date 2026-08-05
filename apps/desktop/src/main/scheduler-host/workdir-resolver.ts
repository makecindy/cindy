/**
 * Phase 3: workdir-resolver
 *
 * useWorktree=true 时为 schedule 创建 ephemeral worktree，自动走 WorktreePool
 * 池化复用（命中时 ~1-2s，未命中时走完整 createWorktree pipeline）。
 *
 * 命名规则 sched-<sessionId 前 8>，sourceBranch 取 baseRepo 当前 HEAD。
 *
 * **不要**手动注册清理：maker-host SessionLifecycleHooks.onClose 已经会
 * 在 session 关闭时尝试池化回收或销毁 worktree。
 */

import type { Schedule } from '@cindy/maker-scheduler';
import { WorktreeManager, WorktreePool } from '../worktree';

export interface WorkdirResolveResult {
  ok: boolean;
  path?: string;
  /**
   * Worktree 上新建的分支名（如 `xdt/sched-abc12345`）。
   * 仅 useWorktree=true 时填；非 worktree 模式下保持 undefined。
   * Runner 应优先使用此字段，避免再用 `git rev-parse --abbrev-ref HEAD` 兜底。
   */
  branch?: string;
  /** session key used to release an acquired ephemeral worktree on cancellation */
  worktreeSessionId?: string;
  error?: string;
}

export async function resolveWorkingDir(
  schedule: Schedule,
  sessionId: string,
): Promise<WorkdirResolveResult> {
  if (!schedule.useWorktree) {
    return { ok: true, path: schedule.workingDir };
  }
  if (!schedule.workingDir) {
    return { ok: false, error: 'useWorktree=true requires workingDir as base repo' };
  }

  const cwd = await WorktreeManager.detectCwd(schedule.workingDir);
  if (!cwd.gitInstalled) return { ok: false, error: 'git not installed' };
  if (!cwd.isGitRepo) return { ok: false, error: 'workingDir not a git repo' };
  const sourceBranch = cwd.currentBranch ?? 'main';

  const name = `sched-${sessionId.slice(0, 8)}`;
  const res = await WorktreePool.acquireWorktree({
    sessionId,
    name,
    baseRepo: schedule.workingDir,
    sourceBranch,
    ephemeral: true,
  });
  if (!res.ok) return { ok: false, error: res.error.message };
  return {
    ok: true,
    path: res.meta.path,
    branch: res.meta.branch,
    worktreeSessionId: sessionId,
  };
}
