import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info('orca_workers')")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  if (columns.size === 0) return;
  for (const [name, type] of [
    ['pending_remote_report', 'text'],
    ['remote_stop_confirmed_at', 'integer'],
  ]) {
    if (!columns.has(name)) db.exec('ALTER TABLE orca_workers ADD ' + name + ' ' + type);
  }
}

module.exports = { run };
