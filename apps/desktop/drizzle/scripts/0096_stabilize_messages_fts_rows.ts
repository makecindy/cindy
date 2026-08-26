import type Database from 'better-sqlite3';

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === 'string' &&
    String((error as Error & { code: string }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

function rebuildFts(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS messages_fts;');
  db.exec('DELETE FROM messages_fts_rows;');
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
  `);
  db.exec(`
    INSERT INTO messages_fts_rows(message_id)
      SELECT id
      FROM messages
      WHERE rewind_at IS NULL
        AND role IN ${FTS_ROLE_WHITELIST}
      ORDER BY rowid;
  `);
  db.exec(`
    INSERT INTO messages_fts(rowid, message_id, session_id, role, content)
      SELECT r.fts_rowid, m.id, m.session_id, m.role, m.content
      FROM messages m
      JOIN messages_fts_rows r ON r.message_id = m.id;
  `);
}

function reuseExistingFtsRows(db: Database.Database): boolean {
  db.exec('DELETE FROM messages_fts_rows;');
  try {
    db.exec(`
      INSERT INTO messages_fts_rows(fts_rowid, message_id)
        SELECT rowid, message_id
        FROM messages_fts;
    `);
  } catch (error) {
    if (isConstraintError(error)) return false;
    throw error;
  }

  const invalidFtsRow = db
    .prepare(
      `SELECT 1
       FROM messages_fts_rows r
       LEFT JOIN messages m ON m.id = r.message_id
       WHERE m.id IS NULL
          OR m.rewind_at IS NOT NULL
          OR m.role NOT IN ${FTS_ROLE_WHITELIST}
       LIMIT 1`,
    )
    .get();
  if (invalidFtsRow) return false;

  const mismatchedFtsRow = db
    .prepare(
      `SELECT 1
       FROM messages_fts f
       JOIN messages_fts_rows r ON r.fts_rowid = f.rowid
       JOIN messages m ON m.id = r.message_id
       WHERE f.message_id IS NOT m.id
          OR f.session_id IS NOT m.session_id
          OR f.role IS NOT m.role
          OR f.content IS NOT m.content
       LIMIT 1`,
    )
    .get();
  if (mismatchedFtsRow) return false;

  const missingFtsRow = db
    .prepare(
      `SELECT 1
       FROM messages m
       LEFT JOIN messages_fts_rows r ON r.message_id = m.id
       WHERE m.rewind_at IS NULL
         AND m.role IN ${FTS_ROLE_WHITELIST}
         AND r.message_id IS NULL
       LIMIT 1`,
    )
    .get();
  return !missingFtsRow;
}

function createTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER messages_fts_insert
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST}
    BEGIN
      INSERT OR IGNORE INTO messages_fts_rows(message_id) VALUES (new.id);
      INSERT OR REPLACE INTO messages_fts(rowid, message_id, session_id, role, content)
        SELECT fts_rowid, new.id, new.session_id, new.role, new.content
        FROM messages_fts_rows
        WHERE message_id = new.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_delete
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts
        WHERE rowid = (
          SELECT fts_rowid FROM messages_fts_rows WHERE message_id = old.id
        );
      DELETE FROM messages_fts_rows WHERE message_id = old.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER messages_fts_update
    AFTER UPDATE OF id, session_id, role, content, rewind_at ON messages
    WHEN old.id IS NOT new.id
      OR old.session_id IS NOT new.session_id
      OR old.role IS NOT new.role
      OR old.content IS NOT new.content
      OR old.rewind_at IS NOT new.rewind_at
    BEGIN
      DELETE FROM messages_fts
        WHERE rowid = (
          SELECT fts_rowid FROM messages_fts_rows WHERE message_id = old.id
        );
      UPDATE messages_fts_rows
        SET message_id = new.id
        WHERE message_id = old.id AND old.id IS NOT new.id;
      INSERT OR IGNORE INTO messages_fts_rows(message_id)
        SELECT new.id
        WHERE new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST};
      INSERT OR REPLACE INTO messages_fts(rowid, message_id, session_id, role, content)
        SELECT fts_rowid, new.id, new.session_id, new.role, new.content
        FROM messages_fts_rows
        WHERE message_id = new.id
          AND new.rewind_at IS NULL
          AND new.role IN ${FTS_ROLE_WHITELIST};
    END;
  `);
}

function run(db: Database.Database): void {
  db.exec('DROP TRIGGER IF EXISTS messages_fts_insert;');
  db.exec('DROP TRIGGER IF EXISTS messages_fts_delete;');
  db.exec('DROP TRIGGER IF EXISTS messages_fts_update;');

  if (!tableExists(db, 'messages')) return;
  if (!tableExists(db, 'messages_fts') || !reuseExistingFtsRows(db)) rebuildFts(db);
  createTriggers(db);
}

module.exports = { run };
