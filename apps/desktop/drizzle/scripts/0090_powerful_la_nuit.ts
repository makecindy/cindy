import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const columns = new Set(tableColumnNames(db, 'subagent_runs'));
  if (!columns.has('transcript_file')) {
    db.exec('ALTER TABLE subagent_runs ADD COLUMN transcript_file text');
  }
}

module.exports = { run };
