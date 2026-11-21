import type Database from 'better-sqlite3';

// 定时任务的模型组(模式)id(model-groups.md §6.3)。只加一列可空 TEXT，不改已有数据；
// 部分旧 schema 没有 schedules 表或已经有这一列时跳过。
function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (columns.some(column => column.name === 'model_group')) return;
  db.exec('ALTER TABLE schedules ADD COLUMN model_group TEXT');
}

module.exports = { run };
