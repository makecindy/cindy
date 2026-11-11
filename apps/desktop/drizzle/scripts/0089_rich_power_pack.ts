import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'right_sidebar_tabs')) return;
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS right_sidebar_tabs_subagents_singleton_idx
       ON right_sidebar_tabs (session_id)
      WHERE kind = 'subagents'`,
  );
}

module.exports = { run };
