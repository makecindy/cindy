import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db
    .prepare("PRAGMA table_info('sessions')")
    .all()
    .map((row) => String((row as { name: unknown }).name));
  if (!columns.includes('writable_dirs')) {
    db.exec("ALTER TABLE sessions ADD COLUMN writable_dirs text DEFAULT '[]' NOT NULL");
  }
}

module.exports = { run };
