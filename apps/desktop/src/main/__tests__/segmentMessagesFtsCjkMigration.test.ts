import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { registerCjkSeg } from '../localDb/registerCjkSeg';
import { repairMessagesFtsRows } from '../localDb/messagesFtsRowsRepair';

const { default: migration } = (await import(
  '../../../drizzle/scripts/0099_segment_messages_fts_cjk'
)) as { default: { run: (db: Database.Database) => void } };

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
  registerCjkSeg(db);
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
    CREATE TABLE messages_fts_rows (
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX messages_fts_rows_message_id_idx
      ON messages_fts_rows(message_id);
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

function matchIds(db: Database.Database, query: string): string[] {
  return db
    .prepare('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY message_id')
    .all(query)
    .map((row) => String((row as { message_id: unknown }).message_id));
}

describe('0099 segment messages_fts CJK', () => {
  it('把连续汉字拆成按字 token，二字词可命中', () => {
    const db = setupLegacyDb();
    insertMessage(db, 'm1', 'user', '登录报错了');
    insertMessage(db, 'm2', 'assistant', '边界检查失败');
    insertMessage(db, 'm3', 'user', 'login bug');
    expect(matchIds(db, '"登录"')).toEqual([]);
    expect(matchIds(db, '"边界"')).toEqual([]);

    migration.run(db);

    expect(ftsRows(db).map((row) => row.content)).toEqual([
      '登 录 报 错 了',
      '边 界 检 查 失 败',
      'login bug',
    ]);
    expect(matchIds(db, '"登 录"')).toEqual(['m1']);
    expect(matchIds(db, '"边 界"')).toEqual(['m2']);
    expect(matchIds(db, '"login"')).toEqual(['m3']);
    db.close();
  });

  it('健康新形态库上再跑 companion 与运行期修复都复用现有 FTS 行', () => {
    const db = setupLegacyDb();
    insertMessage(db, 'm1', 'user', '登录报错了');
    insertMessage(db, 'm-drop', 'user', '临时');
    db.prepare("DELETE FROM messages WHERE id = 'm-drop'").run();
    insertMessage(db, 'm2', 'assistant', '边界');
    migration.run(db);
    const before = ftsRows(db);
    expect(before.some((row) => row.rowid > 1)).toBe(true);

    migration.run(db);
    expect(ftsRows(db)).toEqual(before);
    expect(matchIds(db, '"登 录"')).toEqual(['m1']);

    repairMessagesFtsRows(db);
    expect(ftsRows(db)).toEqual(before);
    expect(matchIds(db, '"边 界"')).toEqual(['m2']);
    db.close();
  });

  it('后续插入走 cjk_seg；新连接漏注册会让写入失败', () => {
    const db = setupLegacyDb();
    migration.run(db);
    insertMessage(db, 'm-new', 'user', '边界');
    expect(matchIds(db, '"边 界"')).toEqual(['m-new']);
    const insertTrigger = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_fts_insert'")
      .get() as { sql: string };
    expect(insertTrigger.sql).toContain('cjk_seg(new.content)');
    db.close();

    const bare = new Database(':memory:');
    bare.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        rewind_at INTEGER
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        tokenize='porter unicode61'
      );
      CREATE TABLE messages_fts_rows (
        fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        message_id TEXT NOT NULL
      );
    `);
    bare.exec(insertTrigger.sql);
    expect(() =>
      bare
        .prepare(
          `INSERT INTO messages(id, session_id, role, content, rewind_at)
           VALUES ('m1', 's1', 'user', '边界', NULL)`,
        )
        .run(),
    ).toThrow(/no such function: cjk_seg/i);
    bare.close();
  });
});
