import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(tableName) !== undefined;
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db.prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'sessions')) return;
  const columns = tableColumnNames(db, 'sessions');
  if (!columns.has('message_epoch')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN message_epoch text DEFAULT '' NOT NULL`);
  }
  if (!columns.has('message_revision')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN message_revision integer DEFAULT 0 NOT NULL`);
  }
  db.exec(`UPDATE sessions SET message_epoch = lower(hex(randomblob(16))) WHERE message_epoch = ''`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS sessions_message_epoch_after_insert
    AFTER INSERT ON sessions
    WHEN NEW.message_epoch = ''
    BEGIN
      UPDATE sessions
      SET message_epoch = lower(hex(randomblob(16)))
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS sessions_message_epoch_after_clear
    AFTER UPDATE OF cleared_at ON sessions
    WHEN OLD.cleared_at IS NOT NEW.cleared_at
    BEGIN
      UPDATE sessions
      SET message_epoch = lower(hex(randomblob(16))), message_revision = 0
      WHERE id = NEW.id;
    END;
  `);
  if (!tableExists(db, 'messages')) return;
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_revision_after_tail_insert
    AFTER INSERT ON messages
    WHEN NOT EXISTS (
      SELECT 1
      FROM messages AS newer
      WHERE newer.session_id = NEW.session_id
        AND newer.rowid <> NEW.rowid
        AND newer.created_at > NEW.created_at
    )
    BEGIN
      UPDATE sessions
      SET message_revision = message_revision + 1
      WHERE id = NEW.session_id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_epoch_after_historical_insert
    AFTER INSERT ON messages
    WHEN EXISTS (
      SELECT 1
      FROM messages AS newer
      WHERE newer.session_id = NEW.session_id
        AND newer.rowid <> NEW.rowid
        AND newer.created_at > NEW.created_at
    )
    BEGIN
      UPDATE sessions
      SET message_epoch = lower(hex(randomblob(16))), message_revision = 0
      WHERE id = NEW.session_id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_epoch_after_update
    AFTER UPDATE ON messages
    BEGIN
      UPDATE sessions
      SET message_epoch = lower(hex(randomblob(16))), message_revision = 0
      WHERE id = OLD.session_id;
      UPDATE sessions
      SET message_epoch = lower(hex(randomblob(16))), message_revision = 0
      WHERE id = NEW.session_id AND NEW.session_id <> OLD.session_id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_epoch_after_delete
    AFTER DELETE ON messages
    BEGIN
      UPDATE sessions
      SET message_epoch = lower(hex(randomblob(16))), message_revision = 0
      WHERE id = OLD.session_id;
    END;
  `);
}

module.exports = { run };
