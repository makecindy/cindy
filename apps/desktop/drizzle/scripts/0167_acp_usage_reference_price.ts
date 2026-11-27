import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(daily_model_usage)').all() as Array<{ name: string }>;
  if (columns.length && !columns.some(column => column.name === 'acp_missing_price')) {
    db.exec('ALTER TABLE daily_model_usage ADD COLUMN acp_missing_price INTEGER');
  }
}

module.exports = { run };
