import type Database from 'better-sqlite3';

interface TableInfoRow {
  name: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function tableColumnNames(
  db: Database.Database,
  tableName: string,
): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info('${tableName}')`).all() as TableInfoRow[]).map(
      (row) => row.name,
    ),
  );
}

function addColumnIfMissing(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  if (!tableExists(db, tableName)) return;
  const columns = tableColumnNames(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function run(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'sessions',
    'total_cost_amount',
    'real DEFAULT 0 NOT NULL',
  );
  addColumnIfMissing(db, 'sessions', 'total_cost_currency', 'text');
  addColumnIfMissing(
    db,
    'sessions',
    'total_cost_is_approximate',
    'integer DEFAULT 0 NOT NULL',
  );

  addColumnIfMissing(
    db,
    'daily_spend',
    'cost_amount',
    'real DEFAULT 0 NOT NULL',
  );
  addColumnIfMissing(db, 'daily_spend', 'cost_currency', 'text');
  addColumnIfMissing(
    db,
    'daily_spend',
    'cost_is_approximate',
    'integer DEFAULT 0 NOT NULL',
  );

  addColumnIfMissing(
    db,
    'daily_model_usage',
    'cost_amount',
    'real DEFAULT 0 NOT NULL',
  );
  addColumnIfMissing(db, 'daily_model_usage', 'cost_currency', 'text');
  addColumnIfMissing(
    db,
    'daily_model_usage',
    'cost_is_approximate',
    'integer DEFAULT 0 NOT NULL',
  );

  addColumnIfMissing(
    db,
    'schedule_runs',
    'cost_amount',
    'real DEFAULT 0 NOT NULL',
  );
  addColumnIfMissing(
    db,
    'schedule_runs',
    'estimated_value_amount',
    'real DEFAULT 0 NOT NULL',
  );
  addColumnIfMissing(db, 'schedule_runs', 'cost_currency', 'text');
  addColumnIfMissing(
    db,
    'schedule_runs',
    'cost_is_approximate',
    'integer DEFAULT 0 NOT NULL',
  );
}

module.exports = { run };
