import type Database from 'better-sqlite3';

import {
  createMessagesFtsPersistentTriggers,
  installCjkSegTempTriggers,
  registerCjkSeg,
} from './registerCjkSeg';

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

function createRowsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_fts_rows (
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_fts_rows_message_id_idx
      ON messages_fts_rows(message_id);
  `);
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
      SELECT r.fts_rowid, m.id, m.session_id, m.role, cjk_seg(m.content)
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
          OR f.content IS NOT cjk_seg(m.content)
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

/** Restores the data-bearing rowid map together with the FTS state that depends on it. */
export function repairMessagesFtsRows(db: Database.Database): void {
  registerCjkSeg(db);
  const run = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS main.messages_fts_insert;');
    db.exec('DROP TRIGGER IF EXISTS main.messages_fts_delete;');
    db.exec('DROP TRIGGER IF EXISTS main.messages_fts_update;');

    createRowsTable(db);
    if (!tableExists(db, 'messages')) return;

    if (!tableExists(db, 'messages_fts') || !reuseExistingFtsRows(db)) rebuildFts(db);
    createMessagesFtsPersistentTriggers(db);
    installCjkSegTempTriggers(db);
  });
  run();
}
