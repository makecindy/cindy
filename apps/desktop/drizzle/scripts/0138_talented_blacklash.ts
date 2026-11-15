import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('session_pr_refs')").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  if (!columns.has('pinned')) {
    db.exec('ALTER TABLE session_pr_refs ADD COLUMN pinned integer DEFAULT false NOT NULL');
  }
  if (!columns.has('priority')) {
    db.exec('ALTER TABLE session_pr_refs ADD COLUMN priority integer DEFAULT 0 NOT NULL');
  }
  if (!columns.has('manually_added')) {
    db.exec('ALTER TABLE session_pr_refs ADD COLUMN manually_added integer DEFAULT false NOT NULL');
  }
  if (!columns.has('removed_at')) {
    db.exec('ALTER TABLE session_pr_refs ADD COLUMN removed_at integer');
  }
}

module.exports = { run };
