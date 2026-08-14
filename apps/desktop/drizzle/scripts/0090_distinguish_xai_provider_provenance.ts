import type Database from 'better-sqlite3';

interface TableInfoRow {
  name: string;
}

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

/**
 * Official xAI became available to Pi only after custom provider ids were namespaced at runtime.
 * Therefore every pre-existing Pi row persisted as `xai` represents the legacy custom connection.
 */
function run(db: Database.Database): void {
  db.transaction(() => {
    if (tableHasColumns(db, 'sessions', ['agent_kind', 'provider_id'])) {
      db.exec(`
        UPDATE sessions
        SET provider_id = 'custom:xai'
        WHERE agent_kind = 'pi' AND provider_id = 'xai'
      `);
    }
    if (tableHasColumns(db, 'schedules', ['agent_kind', 'provider_id'])) {
      db.exec(`
        UPDATE schedules
        SET provider_id = 'custom:xai'
        WHERE agent_kind = 'pi' AND provider_id = 'xai'
      `);
    }
  })();
}

module.exports = { run };
