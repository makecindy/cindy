import type Database from 'better-sqlite3';

// Keep this function self-contained: the inline worker embeds it in its entry point.
// Persistent triggers must also work for SQLite writers without the optional vec0 module.
export function installDeletedTaskVectorCleanup(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deleted_chat_vector_rows'").get()) return;
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS purge_deleted_chat_vector
    AFTER INSERT ON main.deleted_chat_vector_rows
    BEGIN
      DELETE FROM chat_messages_vec_v1 WHERE rowid = NEW.rowid;
      DELETE FROM deleted_chat_vector_rows WHERE rowid = NEW.rowid;
    END;
  `);
  if (db.prepare('SELECT 1 FROM deleted_chat_vector_rows LIMIT 1').get()) {
    db.transaction(() => {
      db.exec('DELETE FROM chat_messages_vec_v1 WHERE rowid IN (SELECT rowid FROM deleted_chat_vector_rows)');
      db.exec('DELETE FROM deleted_chat_vector_rows');
    }).immediate();
  }
}
