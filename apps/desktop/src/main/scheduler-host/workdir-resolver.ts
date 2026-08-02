/**
 * Phase 3: workdir-resolver
 *
 * useWorktree=true 时为 schedule 创建 ephemeral worktree，自动走 WorktreePool
 * 池化复用（命中时 ~1-2s，未命中时走完整 createWorktree pipeline）。
 *
 * 命名规则 sched-<sessionId 前 8>；sourceBranch 经 resolveFreshSourceBranch 取
 * fetch 后的远端默认分支(fail-open:解析失败回退 baseRepo 当前 HEAD)。
 *
 * **不要**手动注册清理：maker-host SessionLifecycleHooks.onClose 已经会
 * 在 session 关闭时尝试池化回收或销毁 worktree。
 */

import type { Schedule } from '@cindy/maker-scheduler';
import { resolveFreshSourceBranch, WorktreeManager, WorktreePool } from '../worktree';

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
  // schedule 的 ephemeral worktree 是「新任务」:以 fetch 后的远端默认分支为源,
  // 不再跟随 baseRepo 当前 HEAD——主仓 checkout 停在旧分支时,旧行为切出的工作区
  // 可落后上游上千 commit(2026-08-02 实踩);解析失败时回退当前分支(fail-open)。
  const fresh = await resolveFreshSourceBranch(schedule.workingDir, cwd.currentBranch ?? 'main');
  const sourceBranch = fresh.sourceBranch;

  const name = `sched-${sessionId.slice(0, 8)}`;
  const res = await WorktreePool.acquireWorktree(
    {
      sessionId,
      name,
      baseRepo: schedule.workingDir,
      sourceBranch,
      ephemeral: true,
    },
    // freshBase 已为本次创建完成网络刷新尝试(成功或耗尽预算)——无论结果如何,
    // 池复用路径都不得再开一份新预算做二次 fetch(离线时会把总等待翻倍到 ~30s)。
    { sourceFetchAlreadyAttempted: true },
  );
  if (!res.ok) return { ok: false, error: res.error.message };
  return {
    ok: true,
    path: res.meta.path,
    branch: res.meta.branch,
    worktreeSessionId: sessionId,
  };
}
