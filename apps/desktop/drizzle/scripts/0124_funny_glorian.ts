import type Database from 'better-sqlite3';

function columnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function addMissingColumns(
  db: Database.Database,
  tableName: string,
  columns: Array<[string, string]>,
): void {
  const existing = columnNames(db, tableName);
  if (existing.size === 0) return;
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE \`${tableName}\` ADD \`${name}\` ${type}`);
  }
}

function run(db: Database.Database): void {
  addMissingColumns(db, 'orca_workers', [
    ['execution_device_id', 'text'],
    ['remote_session_id', 'text'],
    ['last_bridged_message_id', 'text'],
    ['remote_released_at', 'integer'],
  ]);
  addMissingColumns(db, 'sessions', [['orca_remote_lead', 'text']]);
}

module.exports = { run };
