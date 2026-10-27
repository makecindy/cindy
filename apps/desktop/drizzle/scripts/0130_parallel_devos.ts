import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info('schedules')").all() as Array<{ name: string }>;
  if (columns.length === 0 || columns.some((column) => column.name === 'agent_device_id')) return;
  db.exec('ALTER TABLE `schedules` ADD `agent_device_id` text');
}

module.exports = { run };
