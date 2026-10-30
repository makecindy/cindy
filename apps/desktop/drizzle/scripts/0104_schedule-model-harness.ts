import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('schedules')").all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === 'model_agent_kind')) return;
  db.exec('ALTER TABLE `schedules` ADD `model_agent_kind` text');
}

module.exports = { run };
