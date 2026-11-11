import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info('sessions')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
  if (!columns.includes('codex_plan_json')) {
    db.exec('ALTER TABLE sessions ADD COLUMN codex_plan_json text');
  }
}

module.exports = { run };
