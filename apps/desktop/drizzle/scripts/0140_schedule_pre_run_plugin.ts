import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get();
  if (!table) return;
  const columns = new Set((db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has('pre_run_plugin_id')) db.exec('ALTER TABLE schedules ADD pre_run_plugin_id TEXT');
  if (!columns.has('pre_run_plugin_on_failure')) db.exec('ALTER TABLE schedules ADD pre_run_plugin_on_failure TEXT');
}

module.exports = { run };
