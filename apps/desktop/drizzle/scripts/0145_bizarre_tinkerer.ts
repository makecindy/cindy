import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info('session_pr_refs')").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  if (!columns.has('provider')) {
    db.exec("ALTER TABLE session_pr_refs ADD COLUMN provider text DEFAULT 'github' NOT NULL");
  }
  if (!columns.has('host')) {
    db.exec("ALTER TABLE session_pr_refs ADD COLUMN host text DEFAULT 'github.com' NOT NULL");
  }
  db.exec('DROP INDEX IF EXISTS uniq_session_pr_refs');
  db.exec(
    'CREATE UNIQUE INDEX uniq_session_pr_refs ON session_pr_refs (session_id, provider, host, owner, repo, pr_number)',
  );
}

module.exports = { run };
