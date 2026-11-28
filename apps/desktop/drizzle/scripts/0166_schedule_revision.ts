import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (columns.length && !columns.some(column => column.name === 'schedule_revision')) {
    db.exec('ALTER TABLE schedules ADD COLUMN schedule_revision INTEGER DEFAULT 0 NOT NULL');
  }
}

module.exports = { run };
