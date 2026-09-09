import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const { default: migration } =
  (await import('../../../drizzle/scripts/0096_stabilize_messages_fts_rows')) as {
    default: { run: (db: Database.Database) => void };
  };

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";

interface FtsRow {
  rowid: number;
  message_id: string;
  session_id: string;
  role: string;
  content: string;
}

function setupLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_meta TEXT,
      rewind_at INTEGER
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content,
      tokenize='porter unicode61'
    );
    CREATE TRIGGER messages_fts_insert
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST}
    BEGIN
      INSERT INTO messages_fts(message_id, session_id, role, content)
        VALUES (new.id, new.session_id, new.role, new.content);
    END;
    CREATE TRIGGER messages_fts_delete
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
    END;
    CREATE TRIGGER messages_fts_update
    AFTER UPDATE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE message_id = old.id;
      INSERT INTO messages_fts(message_id, session_id, role, content)
        SELECT new.id, new.session_id, new.role, new.content
        WHERE new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST};
    END;
    CREATE TABLE messages_fts_rows (
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX messages_fts_rows_message_id_idx
      ON messages_fts_rows(message_id);
  `);
  return db;
}

function insertMessage(
  db: Database.Database,
  id: string,
  role: string,
  content: string,
  rewindAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO messages(id, session_id, role, content, agent_meta, rewind_at)
     VALUES (?, 's1', ?, ?, NULL, ?)`,
  ).run(id, role, content, rewindAt);
}

function ftsRows(db: Database.Database): FtsRow[] {
  return db
    .prepare(
      `SELECT rowid, message_id, session_id, role, content
       FROM messages_fts
       ORDER BY rowid`,
    )
    .all() as FtsRow[];
}

function mappedRowid(db: Database.Database, messageId: string): number | null {
  const row = db
    .prepare('SELECT fts_rowid FROM messages_fts_rows WHERE message_id = ?')
    .get(messageId) as { fts_rowid: number } | undefined;
  return row?.fts_rowid ?? null;
}

function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
}

describe('0096 stabilize messages_fts rows migration', () => {
  it('复用现有 FTS rowid，并让元数据更新完全绕过 FTS', () => {
    const db = setupLegacyDb();
    insertMessage(db, 'm1', 'user', 'first');
    insertMessage(db, 'm2', 'assistant', 'second');
    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    insertMessage(db, 'm3', 'user', 'third');
    const beforeRows = ftsRows(db);

    migration.run(db);

    expect(
      db.prepare('SELECT fts_rowid, message_id FROM messages_fts_rows ORDER BY fts_rowid').all(),
    ).toEqual(beforeRows.map((row) => ({ fts_rowid: row.rowid, message_id: row.message_id })));

    const changesBefore = totalChanges(db);
    db.prepare('UPDATE messages SET agent_meta = ? WHERE id = ?').run('{"usage":1}', 'm2');
    expect(totalChanges(db) - changesBefore).toBe(1);
    expect(ftsRows(db)).toEqual(beforeRows);

    const triggerSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_update'")
      .get() as { sql: string };
    expect(triggerSql.sql).toContain(
      'AFTER UPDATE OF id, session_id, role, content, rewind_at ON messages',
    );
    expect(triggerSql.sql).not.toContain('agent_meta');

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         DELETE FROM messages_fts
         WHERE rowid = (
           SELECT fts_rowid FROM messages_fts_rows WHERE message_id = ?
         )`,
      )
      .all('m2') as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('messages_fts VIRTUAL TABLE INDEX 0:='))).toBe(
      true,
    );
    expect(
      plan.some(
        (row) =>
          row.detail.includes('SEARCH messages_fts_rows') &&
          row.detail.includes('messages_fts_rows_message_id_idx'),
      ),
    ).toBe(true);
    db.close();
  });

  it('定点维护插入、正文、角色、rewind、主键与物理删除', () => {
    const db = setupLegacyDb();
    migration.run(db);

    insertMessage(db, 'm-user', 'user', 'original');
    insertMessage(db, 'm-tool', 'tool_result', 'not indexed');
    const stableRowid = mappedRowid(db, 'm-user');
    expect(stableRowid).not.toBeNull();
    expect(mappedRowid(db, 'm-tool')).toBeNull();

    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('updated', 'm-user');
    expect(ftsRows(db)).toEqual([
      {
        rowid: stableRowid,
        message_id: 'm-user',
        session_id: 's1',
        role: 'user',
        content: 'updated',
      },
    ]);

    db.prepare('UPDATE messages SET role = ? WHERE id = ?').run('tool_result', 'm-user');
    expect(ftsRows(db)).toEqual([]);
    expect(mappedRowid(db, 'm-user')).toBe(stableRowid);

    db.prepare('UPDATE messages SET role = ? WHERE id = ?').run('assistant', 'm-user');
    expect(mappedRowid(db, 'm-user')).toBe(stableRowid);
    expect(ftsRows(db)[0]?.rowid).toBe(stableRowid);

    db.prepare('UPDATE messages SET rewind_at = 1 WHERE id = ?').run('m-user');
    expect(ftsRows(db)).toEqual([]);
    db.prepare('UPDATE messages SET rewind_at = NULL WHERE id = ?').run('m-user');
    expect(ftsRows(db)[0]?.rowid).toBe(stableRowid);

    db.prepare('UPDATE messages SET id = ?, session_id = ? WHERE id = ?').run(
      'm-renamed',
      's2',
      'm-user',
    );
    expect(mappedRowid(db, 'm-user')).toBeNull();
    expect(mappedRowid(db, 'm-renamed')).toBe(stableRowid);
    expect(ftsRows(db)[0]).toMatchObject({
      rowid: stableRowid,
      message_id: 'm-renamed',
      session_id: 's2',
    });

    db.prepare('DELETE FROM messages WHERE id = ?').run('m-renamed');
    expect(ftsRows(db)).toEqual([]);
    expect(mappedRowid(db, 'm-renamed')).toBeNull();
    db.close();
  });

  it('现有 FTS 重复、孤儿、缺行或字段过期时从 messages 自动重建派生索引', () => {
    const corruptions: Array<(db: Database.Database) => void> = [
      (db) => {
        db.prepare(
          `INSERT INTO messages_fts(message_id, session_id, role, content)
           VALUES ('m1', 's1', 'user', 'stale duplicate')`,
        ).run();
      },
      (db) => {
        db.prepare(
          `INSERT INTO messages_fts(message_id, session_id, role, content)
           VALUES ('orphan', 's1', 'user', 'stale orphan')`,
        ).run();
      },
      (db) => {
        db.prepare("DELETE FROM messages_fts WHERE message_id = 'm1'").run();
      },
      (db) => {
        db.prepare("UPDATE messages_fts SET content = 'stale content' WHERE message_id = 'm1'").run();
      },
      (db) => {
        db.prepare("UPDATE messages_fts SET session_id = 'stale-session' WHERE message_id = 'm1'").run();
      },
      (db) => {
        db.prepare("UPDATE messages_fts SET role = 'assistant' WHERE message_id = 'm1'").run();
      },
    ];

    for (const corrupt of corruptions) {
      const db = setupLegacyDb();
      insertMessage(db, 'm1', 'user', 'canonical');
      corrupt(db);

      migration.run(db);

      expect(ftsRows(db)).toEqual([
        {
          rowid: mappedRowid(db, 'm1'),
          message_id: 'm1',
          session_id: 's1',
          role: 'user',
          content: 'canonical',
        },
      ]);
      expect(() => migration.run(db)).not.toThrow();
      expect(ftsRows(db)).toHaveLength(1);
      db.close();
    }
  });

  it('FTS 缺失时重建，messages 缺失的最小 fixture 安全跳过', () => {
    const rebuildDb = setupLegacyDb();
    insertMessage(rebuildDb, 'm1', 'assistant', 'restore me');
    rebuildDb.exec('DROP TRIGGER messages_fts_insert;');
    rebuildDb.exec('DROP TRIGGER messages_fts_delete;');
    rebuildDb.exec('DROP TRIGGER messages_fts_update;');
    rebuildDb.exec('DROP TABLE messages_fts;');
    migration.run(rebuildDb);
    expect(ftsRows(rebuildDb)).toEqual([
      {
        rowid: mappedRowid(rebuildDb, 'm1'),
        message_id: 'm1',
        session_id: 's1',
        role: 'assistant',
        content: 'restore me',
      },
    ]);
    rebuildDb.close();

    const fixtureDb = new Database(':memory:');
    fixtureDb.exec(`
      CREATE TABLE messages_fts_rows (
        fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        message_id TEXT NOT NULL UNIQUE
      );
    `);
    expect(() => migration.run(fixtureDb)).not.toThrow();
    expect(
      fixtureDb.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_fts_insert'").get(),
    ).toBeUndefined();
    fixtureDb.close();
  });
});
