import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").pluck().all();
  if (columns.length > 0 && !columns.includes('archived_at')) {
    db.exec('ALTER TABLE sessions ADD archived_at integer');
  }
}

module.exports = { run };
