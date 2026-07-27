import type Database from 'better-sqlite3';

/**
 * 0071 — 幂等添加 media_refs.label(画廊 caption 等人类可读备注,可空)。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放(无 IF NOT EXISTS 语义),所以 SQL 文件
 * 只保留注释占位,这里用 PRAGMA table_info 守卫加列(模式同 0069)。
 *
 * ⚠ 本脚本必须保持 CommonJS(function + module.exports),禁止顶层 ESM export /
 * value import —— 生产 Electron 以 raw 形式 require() 加载(见 AGENTS.md 规则 17)。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const columns = new Set(tableColumnNames(db, 'media_refs'));
  if (!columns.has('label')) {
    db.exec('ALTER TABLE media_refs ADD COLUMN label text');
  }
}

module.exports = { run };
