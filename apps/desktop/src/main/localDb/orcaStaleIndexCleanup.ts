/**
 * F-COLLAB:`uniq_orca_workflows_lead_session_id` 全表 unique 索引的兜底清理。
 *
 * 背景:migration 0030 把这条全表 unique 换成了 partial(only WHERE status='active'),
 * 0036 又把残留的全表 unique 删过一次。两条 migration 都只跑一次 —— 但在 dev 端**多 worktree
 * 共用同一份用户 DB** 的场景下,旧分支启动时 `schemaDriftRepair` (只加不删) 会按那个分支
 * 的旧 `schema.ts` 把全表 unique 索引重新建回来。本分支启动后,migration 已经过了 36,不再
 * 处理,`schemaDriftRepair` 也不会删多余的对象,这条 stale index 就一直在,直接导致同一
 * lead session 历史有任何 workflow(completed)就再开协同失败(撞 unique)。
 *
 * 解决:把这条清理做成幂等 + 每次 `ensureReady` 都跑一次,让它成为自愈不变量。
 *  - DROP IF EXISTS:索引不存在时是 no-op(微秒级)。
 *  - 只在 `schema_version >= 36` 时执行 —— 36 之前(0026-0035)那条索引还是 canonical,
 *    不能误删。
 *  - 跑挂了不阻塞启动,只 log。
 *
 * 参考 commit `c94a94d5` (0036 原始上下文) 和 worker review M-1。
 */

import type Database from 'better-sqlite3';

import { createLogger } from '../logger';

const log = createLogger('orca-stale-index-cleanup');

const STALE_INDEX_NAME = 'uniq_orca_workflows_lead_session_id';
const MIN_SCHEMA_VERSION = 36;

export function hasStaleOrcaLeadIndex(db: Database.Database): boolean {
  try {
    const versionRow = db
      .prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`)
      .get() as { value: string } | undefined;
    const version = versionRow ? parseInt(versionRow.value, 10) : -1;
    if (!Number.isFinite(version) || version < MIN_SCHEMA_VERSION) return false;
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(STALE_INDEX_NAME),
    );
  } catch {
    // Read-only startup cannot repair this invariant, so an unreadable catalog is unsafe.
    return true;
  }
}

/**
 * 同步执行:在 `ensureReady` 的 runMigrations + schemaDriftRepair 之后调用。
 * 不抛错 —— 任何异常都被吞掉记日志,不让兜底清理把启动卡死。
 */
export function cleanupStaleOrcaLeadIndex(db: Database.Database): void {
  try {
    const versionRow = db
      .prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`)
      .get() as { value: string } | undefined;
    const version = versionRow ? parseInt(versionRow.value, 10) : -1;
    if (!Number.isFinite(version) || version < MIN_SCHEMA_VERSION) return;

    const indexRow = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`)
      .get(STALE_INDEX_NAME);
    if (!indexRow) return;

    db.exec(`DROP INDEX IF EXISTS \`${STALE_INDEX_NAME}\``);
    log.warn(
      JSON.stringify({
        event: 'localDb.cleanup.staleOrcaLeadIndex.dropped',
        index: STALE_INDEX_NAME,
        reason:
          'index re-appeared after migration 0036; likely a stale worktree recreated it via schemaDriftRepair',
      }),
    );
  } catch (err) {
    log.warn(
      JSON.stringify({
        event: 'localDb.cleanup.staleOrcaLeadIndex.failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
