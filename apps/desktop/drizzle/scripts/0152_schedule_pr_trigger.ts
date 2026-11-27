import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (columns.length && !columns.some(column => column.name === 'pr_trigger')) {
    db.exec('ALTER TABLE schedules ADD pr_trigger TEXT');
  }
}

module.exports = { run };
