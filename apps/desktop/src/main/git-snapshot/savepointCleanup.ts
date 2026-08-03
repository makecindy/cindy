/**
 * shadow savepoint 链的生命周期清理。
 *
 * - 会话显式删除后删除其 refs/cindy/savepoints/<sessionId>(归档保留:归档可
 *   恢复,恢复后文件回退仍要可用;与 worktree 启动期对账"archived 不回收"的
 *   保守口径一致)。
 * - 启动期对账:遍历会话工作目录对应的 repo,清掉 owning session 已删除或行
 *   已缺失的孤儿 ref(删除动作与清理之间的崩溃窗口兜底)。
 *
 * v1 不主动跑 git gc:删 ref 后保存点对象不可达,由用户仓库自身的 gc 策略
 * 回收;后续增强再考虑对空闲 repo 触发 git gc --auto。
 */

import path from 'node:path';

import { eq, inArray, isNotNull } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { createLogger } from '../logger';
import { gitExec } from '../worktree/gitExec';
import { deleteSavepointRef, listSavepointRefs } from './savepointRefs';

const log = createLogger('git-snapshot');

/** 启动期对账最多探测的 distinct 工作目录数,避免超大会话库拖慢启动。 */
const RECONCILE_MAX_WORKDIRS = 200;

/**
 * 判定与 maker-host 的 defaultDetectRepoRoot 同口径:git 可用、是仓库、
 * 非 linked worktree(linked worktree 会话全链路不产生保存点链)。
 * 刻意不用 WorktreeManager.detectCwd:本模块被 localDb/ipc/sessions 静态
 * 导入,经 WorktreeManager → worktreeStore 会绕回 sessions 形成模块环。
 */
async function resolveSavepointRepoRoot(workingDir: string): Promise<string | null> {
  try {
    const repoRoot = (await gitExec(['rev-parse', '--show-toplevel'], workingDir)).stdout.trim();
    if (!repoRoot) return null;
    const [gitDir, commonDir] = await Promise.all([
      gitExec(['rev-parse', '--git-dir'], workingDir),
      gitExec(['rev-parse', '--git-common-dir'], workingDir),
    ]);
    // rev-parse 输出的相对路径以命令的 cwd(workingDir)为基准,与
    // WorktreeManager.detectCwd 同口径;用 repoRoot 作基准会在子目录场景
    // 下解析错。
    const isInsideWorktree =
      path.resolve(workingDir, gitDir.stdout.trim()) !==
      path.resolve(workingDir, commonDir.stdout.trim());
    if (isInsideWorktree) return null;
    return repoRoot;
  } catch {
    // git 不可用 / 非仓库 / 目录已被删除:都视为无可清理的保存点。
    return null;
  }
}

/**
 * 会话删除后的保存点链清理。fire-and-forget 语义:任何失败只记日志,由启动期
 * reconcileSavepointRefsForDeletedSessions() 兜底。
 */
export async function cleanupSavepointsForRemovedSession(sessionId: string): Promise<void> {
  try {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ status: sessions.status, workingDir: sessions.workingDir })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    // 行已缺失同样视为已删除;状态被并发改回非 deleted 时保留保存点。
    if (row && row.status !== 'deleted') return;
    if (!row?.workingDir) return;

    const repoRoot = await resolveSavepointRepoRoot(row.workingDir);
    if (!repoRoot) return;
    await deleteSavepointRef(repoRoot, sessionId);
    log.info('[savepoint-cleanup] savepoint chain removed for deleted session', {
      sessionId,
      repoRoot,
    });
  } catch (err) {
    log.warn('[savepoint-cleanup] cleanup after session delete failed (swallowed)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 启动期对账:清掉 owning session 已删除/行已缺失的孤儿保存点 ref。
 *
 * 只扫描当前会话表里仍出现的工作目录;所有会话行都已物理清除的 repo 无从定位,
 * 其残留 ref 留待该目录再次被会话使用时的下一轮对账。DB 查询失败整体跳过,
 * 宁可保留也不误删。
 */
export async function reconcileSavepointRefsForDeletedSessions(): Promise<void> {
  let rows: Array<{ id: string; status: string | null; workingDir: string | null }>;
  try {
    const db = getDbClient().drizzle;
    rows = await db
      .select({ id: sessions.id, status: sessions.status, workingDir: sessions.workingDir })
      .from(sessions)
      .where(isNotNull(sessions.workingDir));
  } catch (err) {
    log.warn('[savepoint-cleanup] reconcile skipped: session query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const workDirs: string[] = [];
  const seenDirs = new Set<string>();
  for (const row of rows) {
    if (!row.workingDir || seenDirs.has(row.workingDir)) continue;
    seenDirs.add(row.workingDir);
    workDirs.push(row.workingDir);
    if (workDirs.length >= RECONCILE_MAX_WORKDIRS) break;
  }

  const seenRepoRoots = new Set<string>();
  for (const workingDir of workDirs) {
    try {
      const repoRoot = await resolveSavepointRepoRoot(workingDir);
      if (!repoRoot || seenRepoRoots.has(repoRoot)) continue;
      seenRepoRoots.add(repoRoot);

      const refs = await listSavepointRefs(repoRoot);
      if (refs.length === 0) continue;

      const db = getDbClient().drizzle;
      const owners = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(inArray(sessions.id, refs.map((ref) => ref.sessionId)));
      const aliveIds = new Set(
        owners.filter((owner) => owner.status !== 'deleted').map((owner) => owner.id),
      );

      for (const ref of refs) {
        if (aliveIds.has(ref.sessionId)) continue;
        await deleteSavepointRef(repoRoot, ref.sessionId);
        log.info('[savepoint-cleanup] orphan savepoint chain removed', {
          sessionId: ref.sessionId,
          repoRoot,
        });
      }
    } catch (err) {
      log.debug('[savepoint-cleanup] reconcile for workdir failed (continuing)', {
        workingDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
