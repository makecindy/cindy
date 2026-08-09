import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(tableName),
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules')) return;
  db.transaction(() => {
    db.exec(`
      UPDATE schedules
      SET origin_kind = NULL,
          origin_id = NULL,
          status = CASE WHEN status = 'active' THEN 'paused' ELSE status END
      WHERE id IN (
        SELECT id
        FROM (
          SELECT
            id,
            row_number() OVER (
              PARTITION BY origin_kind, origin_id
              ORDER BY updated_at DESC, created_at DESC, id DESC
            ) AS rn
          FROM schedules
          WHERE origin_kind IS NOT NULL
            AND origin_id IS NOT NULL
        )
        WHERE rn > 1
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS uniq_schedules_origin ON schedules(origin_kind, origin_id)',
    );
  })();
}

module.exports = { run };
