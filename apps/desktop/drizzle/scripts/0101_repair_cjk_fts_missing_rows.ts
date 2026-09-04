import type Database from 'better-sqlite3';

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";
const HAN_CHAR_RE = /\p{Script=Han}/u;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const MARK_RE = /\p{M}/u;

function isHanCodePoint(ch: string): boolean {
  return HAN_CHAR_RE.test(ch);
}

function isLetterOrNumber(ch: string): boolean {
  return LETTER_OR_NUMBER_RE.test(ch);
}

function isMark(ch: string): boolean {
  return MARK_RE.test(ch);
}

function cjkSeg(input: unknown): string | null {
  if (input == null) return null;
  const text = typeof input === 'string' ? input : String(input);
  if (text.length === 0) return text;
  const chars = Array.from(text);
  let out = '';
  let lastBoundary = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (isMark(ch)) {
      out += ch;
      continue;
    }
    if (lastBoundary) {
      const hanNow = isHanCodePoint(ch);
      const hanPrev = isHanCodePoint(lastBoundary);
      if (
        (hanNow && hanPrev) ||
        (hanNow && isLetterOrNumber(lastBoundary)) ||
        (hanPrev && isLetterOrNumber(ch))
      ) {
        out += ' ';
      }
    }
    out += ch;
    lastBoundary = ch;
  }
  return out;
}

function registerCjkSeg(db: Database.Database): void {
  db.function('cjk_seg', { deterministic: true }, cjkSeg);
}

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

function createPersistentTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER messages_fts_insert
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST}
      AND NOT EXISTS (SELECT 1 FROM pragma_function_list WHERE name='cjk_seg')
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
    WHEN (old.id IS NOT new.id
      OR old.session_id IS NOT new.session_id
      OR old.role IS NOT new.role
      OR old.content IS NOT new.content
      OR old.rewind_at IS NOT new.rewind_at)
      AND NOT EXISTS (SELECT 1 FROM pragma_function_list WHERE name='cjk_seg')
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

function installCjkSegTempTriggers(db: Database.Database): void {
  if (!tableExists(db, 'messages') || !tableExists(db, 'messages_fts') || !tableExists(db, 'messages_fts_rows')) {
    return;
  }

  db.exec('DROP TRIGGER IF EXISTS temp.messages_fts_insert_cjk;');
  db.exec('DROP TRIGGER IF EXISTS temp.messages_fts_update_cjk;');

  db.exec(`
    CREATE TEMP TRIGGER messages_fts_insert_cjk
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST}
    BEGIN
      INSERT OR IGNORE INTO messages_fts_rows(message_id) VALUES (new.id);
      INSERT OR REPLACE INTO messages_fts(rowid, message_id, session_id, role, content)
        SELECT fts_rowid, new.id, new.session_id, new.role, cjk_seg(new.content)
        FROM messages_fts_rows
        WHERE message_id = new.id;
    END;
  `);

  db.exec(`
    CREATE TEMP TRIGGER messages_fts_update_cjk
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
        SELECT fts_rowid, new.id, new.session_id, new.role, cjk_seg(new.content)
        FROM messages_fts_rows
        WHERE message_id = new.id
          AND new.rewind_at IS NULL
          AND new.role IN ${FTS_ROLE_WHITELIST};
    END;
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
  return true;
}

function rebuildFts(db: Database.Database): void {
  db.exec('DELETE FROM messages_fts;');
  db.exec('DELETE FROM messages_fts_rows;');
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

function backfillMissingFtsRows(db: Database.Database): void {
  db.exec(`
    INSERT OR IGNORE INTO messages_fts_rows(message_id)
      SELECT m.id
      FROM messages m
      LEFT JOIN messages_fts_rows r ON r.message_id = m.id
      WHERE m.rewind_at IS NULL
        AND m.role IN ${FTS_ROLE_WHITELIST}
        AND r.message_id IS NULL
      ORDER BY m.rowid;
  `);
  db.exec(`
    INSERT OR REPLACE INTO messages_fts(rowid, message_id, session_id, role, content)
      SELECT r.fts_rowid, m.id, m.session_id, m.role, cjk_seg(m.content)
      FROM messages m
      JOIN messages_fts_rows r ON r.message_id = m.id
      LEFT JOIN messages_fts f ON f.rowid = r.fts_rowid
      WHERE m.rewind_at IS NULL
        AND m.role IN ${FTS_ROLE_WHITELIST}
        AND f.rowid IS NULL;
  `);
}

function restoreSchemaAndTriggers(db: Database.Database): void {
  db.exec('DROP TRIGGER IF EXISTS main.messages_fts_insert;');
  db.exec('DROP TRIGGER IF EXISTS main.messages_fts_delete;');
  db.exec('DROP TRIGGER IF EXISTS main.messages_fts_update;');
  createRowsTable(db);
  if (!tableExists(db, 'messages_fts')) {
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        tokenize='porter unicode61'
      );
    `);
  }
  createPersistentTriggers(db);
  installCjkSegTempTriggers(db);
}

function run(db: Database.Database): void {
  registerCjkSeg(db);
  if (!tableExists(db, 'messages')) return;
  if (!tableExists(db, 'messages_fts')) {
    restoreSchemaAndTriggers(db);
    rebuildFts(db);
    return;
  }
  if (!tableExists(db, 'messages_fts_rows')) {
    restoreSchemaAndTriggers(db);
    if (!reuseExistingFtsRows(db)) {
      rebuildFts(db);
      return;
    }
    backfillMissingFtsRows(db);
    return;
  }
  backfillMissingFtsRows(db);
  installCjkSegTempTriggers(db);
}

module.exports = { run };
