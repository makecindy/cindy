import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === columnName);
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'subagent_runs')) return;
  const columns = [
    ['returned_result', 'TEXT'],
    ['returned_result_empty', 'INTEGER'],
    ['returned_result_truncated', 'INTEGER'],
    ['cost_usd', 'REAL'],
  ] as const;
  for (const [name, type] of columns) {
    if (!columnExists(db, 'subagent_runs', name)) {
      db.exec(`ALTER TABLE subagent_runs ADD COLUMN ${name} ${type}`);
    }
  }
}

module.exports = { run };
