import type Database from 'better-sqlite3';

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'messages') || !tableExists(db, 'messages_fts')) return;

  db.exec('DROP TRIGGER IF EXISTS messages_fts_update;');

  db.exec(`
    CREATE TRIGGER messages_fts_update
    AFTER UPDATE ON messages
    WHEN old.role IN ${FTS_ROLE_WHITELIST} OR new.role IN ${FTS_ROLE_WHITELIST}
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(message_id, session_id, role, content)
        SELECT new.id, new.session_id, new.role, new.content
        WHERE new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST};
    END;
  `);
}

module.exports = { run };
