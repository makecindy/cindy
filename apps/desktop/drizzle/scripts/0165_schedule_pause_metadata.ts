import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  const names = new Set(columns.map(column => column.name));
  if (!names.has('paused_until')) db.exec('ALTER TABLE schedules ADD COLUMN paused_until INTEGER');
  if (!names.has('pause_reason')) db.exec('ALTER TABLE schedules ADD COLUMN pause_reason TEXT');
}

module.exports = { run };
