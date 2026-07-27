import type Database from 'better-sqlite3';

/**
 * 0082 — 幂等添加 schedules.active_claim_fired_at。
 *
 * 该列是自动触发 claim 的持久化标记。runNow 会更新 last_fired_at 给 UI,
 * 但不能覆盖这个标记,否则启动归一/僵尸清扫会把手动 run 误判为自动 claim。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,SQL 文件只保留占位查询,
 * 这里用 PRAGMA table_info 守卫加列。
 *
 * 本脚本必须保持 CommonJS(function + module.exports),生产 Electron 会直接 require。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules')) return;
  const columns = new Set(tableColumnNames(db, 'schedules'));
  if (!columns.has('active_claim_fired_at')) {
    db.exec('ALTER TABLE schedules ADD COLUMN active_claim_fired_at integer');
  }
}

module.exports = { run };
