import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const row = db.prepare(`PRAGMA table_info('${tableName}')`).all() as { name: string }[];
  return row.some((column) => column.name === columnName);
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'custom_providers')) return;
  if (columnExists(db, 'custom_providers', 'usage')) return;
  db.exec('ALTER TABLE `custom_providers` ADD `usage` text;');
}

module.exports = { run };
