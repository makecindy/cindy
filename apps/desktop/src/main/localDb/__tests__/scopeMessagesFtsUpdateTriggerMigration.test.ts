import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const { default: migration0066 } = (await import(
  '../../../../drizzle/scripts/0066_slim_messages_fts'
)) as { default: { run(db: Database.Database): void } };
const { default: migration0095 } = (await import(
  '../../../../drizzle/scripts/0095_scope_messages_fts_update_trigger'
)) as { default: { run(db: Database.Database): void } };

function createMessagesDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      rewind_at INTEGER
    );
  `);
  return db;
}

function insertMessage(
  db: Database.Database,
  row: { id: string; role: string; content: string; rewindAt?: number | null },
): void {
  db.prepare(
    'INSERT INTO messages (id, client_id, session_id, role, content, rewind_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, `client-${row.id}`, 's1', row.role, row.content, row.rewindAt ?? null);
}

function ftsRows(db: Database.Database): Array<{ message_id: string; content: string }> {
  return db
    .prepare('SELECT message_id, content FROM messages_fts ORDER BY message_id')
    .all() as Array<{ message_id: string; content: string }>;
}

describe('0095 scope messages_fts update trigger', () => {
  it('adds a role WHEN clause so non-whitelist updates skip the FTS delete scan', () => {
    const db = createMessagesDb();
    try {
      migration0066.run(db);
      migration0095.run(db);

      const trigger = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_update'")
        .get() as { sql: string } | undefined;
      expect(trigger?.sql).toContain('WHEN old.role IN');
      expect(trigger?.sql).toContain('OR new.role IN');
    } finally {
      db.close();
    }
  });

  it('leaves FTS untouched when a tool_result row is updated', () => {
    const db = createMessagesDb();
    try {
      migration0066.run(db);
      insertMessage(db, { id: 'a1', role: 'assistant', content: 'hello world' });
      insertMessage(db, { id: 't1', role: 'tool_result', content: 'chunk one' });
      migration0095.run(db);

      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('chunk one two', 't1');

      expect(ftsRows(db)).toEqual([{ message_id: 'a1', content: 'hello world' }]);
    } finally {
      db.close();
    }
  });

  it('still maintains FTS for whitelist-role updates and rewind hiding', () => {
    const db = createMessagesDb();
    try {
      migration0066.run(db);
      migration0095.run(db);
      insertMessage(db, { id: 'a1', role: 'assistant', content: 'first draft' });

      db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('final answer', 'a1');
      expect(ftsRows(db)).toEqual([{ message_id: 'a1', content: 'final answer' }]);

      db.prepare('UPDATE messages SET rewind_at = ? WHERE id = ?').run(123, 'a1');
      expect(ftsRows(db)).toEqual([]);

      db.prepare('UPDATE messages SET rewind_at = NULL WHERE id = ?').run('a1');
      expect(ftsRows(db)).toEqual([{ message_id: 'a1', content: 'final answer' }]);
    } finally {
      db.close();
    }
  });

  it('removes the FTS row when a whitelist role is rewritten to a tombstone', () => {
    const db = createMessagesDb();
    try {
      migration0066.run(db);
      migration0095.run(db);
      insertMessage(db, { id: 'a1', role: 'assistant', content: 'to be deleted' });
      expect(ftsRows(db)).toHaveLength(1);

      db.prepare("UPDATE messages SET role = 'message_tombstone', content = '' WHERE id = ?").run('a1');
      expect(ftsRows(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('is safe on databases without the messages or messages_fts tables', () => {
    const empty = new Database(':memory:');
    try {
      expect(() => migration0095.run(empty)).not.toThrow();
    } finally {
      empty.close();
    }
    const withoutFts = createMessagesDb();
    try {
      expect(() => migration0095.run(withoutFts)).not.toThrow();
      const trigger = withoutFts
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_update'")
        .get();
      expect(trigger).toBeUndefined();
    } finally {
      withoutFts.close();
    }
  });
});
