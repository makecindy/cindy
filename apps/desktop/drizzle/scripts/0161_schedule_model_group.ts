import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some(column => column.name === 'model_group')) return;
  db.exec('ALTER TABLE schedules ADD COLUMN model_group TEXT');
}

module.exports = { run };
