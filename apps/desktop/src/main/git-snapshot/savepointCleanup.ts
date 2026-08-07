/**
 * shadow savepoint 链的生命周期清理。
 *
 * 唯一删除驱动是启动期对账:遍历会话工作目录对应的 repo,清掉当前账号 DB 里
 * status='deleted' 的会话的 ref。刻意**没有**会话删除时的即时清理——覆盖导入等
 * 流程会把旧会话瞬态置为 deleted、失败后经 journal 恢复原状态,任何由 status
 * 变化触发的 ref 删除都与这类回滚竞态(ref 删了即不可逆);启动期不存在进行中
 * 的瞬态软删流程,对账时的 deleted 才是稳定终态。归档会话的 ref 保留:归档可
 * 恢复,恢复后文件回退仍要可用(与 worktree 对账"archived 不回收"同口径)。
 *
 * v1 不主动跑 git gc:删 ref 后保存点对象不可达,由用户仓库自身的 gc 策略
 * 回收;后续增强再考虑对空闲 repo 触发 git gc --auto。
 */

import path from 'node:path';

import { inArray, isNotNull } from 'drizzle-orm';

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
 * 刻意不用 WorktreeManager.detectCwd:保持只依赖 gitExec / localDb 叶子模块,
 * 避免经 WorktreeManager → worktreeStore 绕回 localDb/ipc/sessions 的模块环。
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
 * 启动期对账:清掉 owning session 在当前账号 DB 里已标记 deleted 的保存点 ref。
 *
 * 行缺失的 ref 保留(可能属于本机另一账号的会话,localDb 按账号隔离,无法证明
 * 是孤儿)。只扫描当前会话表里仍出现的工作目录;所有会话行都已物理清除的 repo
 * 无从定位,其残留 ref 留待该目录再次被会话使用时的下一轮对账。DB 查询失败
 * 整体跳过,宁可保留也不误删。
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
      // 只删当前账号 DB 里能证明 status='deleted' 的 ref。行缺失**不是**孤儿
      // 证据:localDb 按账号隔离,同一仓库可能挂着另一账号会话的链,误删即
      // 永久丢那个账号的回退历史。代价是行被物理清除的会话 ref 无人回收——
      // 与"宁可保留也不误删"的模块口径一致。
      const deletableIds = new Set(
        owners.filter((owner) => owner.status === 'deleted').map((owner) => owner.id),
      );

      for (const ref of refs) {
        if (!deletableIds.has(ref.sessionId)) continue;
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
