import type Database from 'better-sqlite3';

interface TableInfoRow {
  name: string;
}

const OFFICIAL_PI_XAI_INTRODUCED_AT_MS = 1_785_540_089_000;

function tableHasColumns(
  db: Database.Database,
  tableName: string,
  requiredColumns: string[],
): boolean {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info('${tableName}')`).all() as TableInfoRow[]).map(
      (row) => row.name,
    ),
  );
  return requiredColumns.every((column) => columns.has(column));
}

function run(db: Database.Database): void {
  db.transaction(() => {
    if (tableHasColumns(db, 'sessions', ['agent_kind', 'provider_id', 'created_at'])) {
      db.exec(`
        UPDATE sessions
        SET provider_id = 'custom:xai'
        WHERE agent_kind = 'pi'
          AND provider_id = 'xai'
          AND created_at < ${OFFICIAL_PI_XAI_INTRODUCED_AT_MS}
      `);
    }
    if (tableHasColumns(db, 'schedules', ['agent_kind', 'provider_id', 'created_at'])) {
      db.exec(`
        UPDATE schedules
        SET provider_id = 'custom:xai'
        WHERE agent_kind = 'pi'
          AND provider_id = 'xai'
          AND created_at < ${OFFICIAL_PI_XAI_INTRODUCED_AT_MS}
      `);
    }
  })();
}

module.exports = { run };
