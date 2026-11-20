import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('sessions')").pluck().all();
  if (columns.length > 0 && !columns.includes('side_chat_close_pending')) {
    db.exec('ALTER TABLE sessions ADD side_chat_close_pending integer DEFAULT false NOT NULL');
  }
}

module.exports = { run };
