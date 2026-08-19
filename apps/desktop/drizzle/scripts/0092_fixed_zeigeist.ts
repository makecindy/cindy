import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info('media_invocations')`).all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === 'response_json')) return;
  db.exec('ALTER TABLE `media_invocations` ADD `response_json` text');
}

module.exports = { run };
