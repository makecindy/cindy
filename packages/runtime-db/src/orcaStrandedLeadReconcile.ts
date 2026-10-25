/**
 * F-COLLAB:启动时幂等修复被中途打断的「关闭协同」遗留的悬空 orca 状态。
 *
 * 背景:关闭协同的唯一入口 `disableOrcaInternal` 是一段**非原子**的多步串行 DB 写
 * (`markTeamEnded` → `markWorkersStatusByTeam` → `archiveWorkersByTeam` →
 * `setSessionOrcaRole(null)`)。如果进程在中途退出 / 崩溃,会留下两类悬空态:
 *
 *  1. **悬空 Lead**:team 已非 active,但 Lead 的 `orca_role` 还停在 `'lead'`。renderer 的
 *     `collabEnabled` 只看 `orca_role`(见 `CCAgentSessionView.tsx`),会把会话永久困在空的
 *     split view(「等待 Worker」);再点 X 关闭又会在 `disableOrcaInternal` 的「no active team」
 *     早返回里 no-op —— 坏态自锁。
 *  2. **孤儿 Worker**:若打断发生在 `archiveWorkersByTeam` 之前,team 已非 active 但 worker
 *     session 仍停在 `status='active'` + `orca_role='worker'` —— 既被 sidebar 的 worker 过滤
 *     隐藏,又因为 `listWorkersByLead` 只看 active team 而无法触达,成为永远收不回来的孤儿。
 *
 * 这里在每次启动 `ensureReady` 时用一个事务做幂等兜底:
 *  - 归档「属于非 active team」且尚未归档的 worker session(`orca_role` 保留 `'worker'` 作历史)。
 *  - 把非 active team 的 `orca_workers` 收敛 `'done'`(对齐 `markWorkersStatusByTeam`)。
 *  - 清掉「`orca_role='lead'` 且无 active team」的悬空 Lead。
 * 三者都只命中非 active team;有 active team 的健康协同会话原样保留。幂等:已收敛的行不会再被
 * 命中,重复跑是 no-op。跑挂了不阻塞启动,只 log。
 *
 * 注意:本进程内通过 UI / MCP 关闭协同的**实时**修复由 `disableOrcaInternal` 自身完成(其
 * 「no active team」分支会 reconcile 悬空 lead + 孤儿 worker);本 sweep 负责「上一次会话遗留、
 * 本次启动前就已经悬空」的历史坏态。
 */

import type Database from 'better-sqlite3';
import type { DbLogger } from './logging.js';

export function createOrcaLeadReconcile(logger: DbLogger) {


const log = logger;

/**
 * 同步执行:在 `ensureReady` 的 runMigrations + schemaDriftRepair + cleanupStaleOrcaLeadIndex
 * 之后调用(此时 schema 已是 HEAD,`orca_teams` / `orca_workers` 表一定存在)。三步写包在一个
 * 事务里,保证要么全成、要么全不动。不抛错 —— 任何异常都吞掉记日志,不让兜底修复把启动卡死。
 */
function reconcileStrandedOrcaLeads(db: Database.Database): void {
  try {
    const run = db.transaction(() => {
      // 1) 归档「属于非 active team」且仍 active 的孤儿 worker session(对齐 archiveWorkersByTeam)。
      //    只命中 status='active' —— 已 archived 的无需再动,已被用户软删除的 status='deleted'
      //    必须原样保留(不能借 reconcile 复活用户删掉的记录)。
      const archivedWorkerSessions = db
        .prepare(
          `UPDATE sessions SET status = 'archived'
           WHERE orca_role = 'worker' AND status = 'active'
             AND id IN (
               SELECT w.session_id FROM orca_workers w
               JOIN orca_teams t ON w.team_id = t.id
               WHERE t.status != 'active'
             )`,
        )
        .run().changes;

      // 2) 把非 active team 的 orca_workers 收敛 done(对齐 markWorkersStatusByTeam)。
      const doneWorkers = db
        .prepare(
          `UPDATE orca_workers SET status = 'done'
           WHERE status != 'done'
             AND team_id IN (SELECT id FROM orca_teams WHERE status != 'active')`,
        )
        .run().changes;

      // 3) 清掉「orca_role='lead' 且无 active team」的悬空 Lead。
      const clearedLeads = db
        .prepare(
          `UPDATE sessions SET orca_role = NULL
           WHERE orca_role = 'lead'
             AND id NOT IN (
               SELECT lead_session_id FROM orca_teams WHERE status = 'active'
             )`,
        )
        .run().changes;

      return { archivedWorkerSessions, doneWorkers, clearedLeads };
    });

    const res = run();
    if (res.archivedWorkerSessions > 0 || res.doneWorkers > 0 || res.clearedLeads > 0) {
      log.warn(
        JSON.stringify({
          event: 'localDb.reconcile.strandedOrcaState.cleared',
          ...res,
          reason:
            'an interrupted disableOrcaInternal left a stranded lead and/or orphaned workers from a non-active team; reconciled to a clean state',
        }),
      );
    }
  } catch (err) {
    log.warn(
      JSON.stringify({
        event: 'localDb.reconcile.strandedOrcaState.failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
return { reconcileStrandedOrcaLeads };
}
