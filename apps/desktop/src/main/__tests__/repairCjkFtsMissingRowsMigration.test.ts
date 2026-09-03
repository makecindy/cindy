import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { registerCjkSeg } from '../localDb/registerCjkSeg';

const { default: migration } = (await import(
  '../../../drizzle/scripts/0101_repair_cjk_fts_missing_rows'
)) as { default: { run: (db: Database.Database) => void } };

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";

/**
 * #3841 存量补建：0100 应用后，worker 连接的 TEMP 触发器曾被
 * temp_store pragma 静默清除，增量消息进了 messages 主表但没进 FTS
 * （messages_fts_rows 缺行）。0101 对已应用 0100 的库做行级缺口检测，
 * 有缺口或 FTS 内容陈旧才走与 0100 相同的 rebuild。
 */

function setupPost0100Db(): Database.Database {
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
      AND NOT EXISTS (SELECT 1 FROM pragma_function_list WHERE name='cjk_seg')
    BEGIN
      INSERT OR IGNORE INTO messages_fts_rows(message_id) VALUES (new.id);
      INSERT OR REPLACE INTO messages_fts(rowid, message_id, session_id, role, content)
        SELECT fts_rowid, new.id, new.session_id, new.role, new.content
        FROM messages_fts_rows WHERE message_id = new.id;
    END;
  `);
  return db;
}

/** 模拟 #3841 现场消息表：TEMP 触发器失效期间写入的行（主表有、FTS/映射无）。 */
function insertOrphanMessage(db: Database.Database, id: string, content: string): void {
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content) VALUES (?, 's', 'user', ?)",
  ).run(id, content);
}

describe('0101 repair cjk fts missing rows', () => {
  it('有缺口（主表有行、FTS 缺行）时 rebuild 补齐并可按字召回', () => {
    const db = setupPost0100Db();
    insertOrphanMessage(db, 'gap1', '登录报错了');
    insertOrphanMessage(db, 'gap2', 'foo登录bar');
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts_rows').get(),
    ).toEqual({ n: 0 });

    migration.run(db);

    expect(
      db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('gap1'),
    ).toEqual({ content: '登 录 报 错 了' });
    expect(
      db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('gap2'),
    ).toEqual({ content: 'foo 登 录 bar' });
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"登 录"')?.n,
    ).toBe(2); // gap1 与 gap2 都含「登录」
    const rowsBefore = db.prepare(
      'SELECT fts_rowid, message_id FROM messages_fts_rows ORDER BY fts_rowid',
    ).all();
    const ftsBefore = db.prepare(
      'SELECT rowid, message_id, session_id, role, content FROM messages_fts ORDER BY rowid',
    ).all();
    migration.run(db);
    expect(
      db.prepare('SELECT fts_rowid, message_id FROM messages_fts_rows ORDER BY fts_rowid').all(),
    ).toEqual(rowsBefore);
    expect(
      db.prepare('SELECT rowid, message_id, session_id, role, content FROM messages_fts ORDER BY rowid').all(),
    ).toEqual(ftsBefore);
    db.close();
  });

  it('部分缺口（旧 FTS 行仍在 + 增量缺映射）rebuild 不撞唯一索引，全量补齐', () => {
    const db = setupPost0100Db();
    // 旧消息已正常进 FTS（#3841 之前写入的存量行）
    insertOrphanMessage(db, 'old1', '旧消息正常索引');
    db.prepare('INSERT INTO messages_fts_rows(message_id) VALUES (?)').run('old1');
    db.prepare(
      `INSERT INTO messages_fts(rowid, message_id, session_id, role, content)
       SELECT fts_rowid, 'old1', 's', 'user', '旧 消 息 正 常 索 引'
       FROM messages_fts_rows WHERE message_id = 'old1'`,
    ).run();
    // 触发器失效期间写入的增量：主表有行、映射缺失
    insertOrphanMessage(db, 'gap1', '登录报错了');
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts_rows').get(),
    ).toEqual({ n: 1 });

    expect(() => migration.run(db)).not.toThrow();

    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts_rows').get(),
    ).toEqual({ n: 2 });
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"登 录"')?.n,
    ).toBe(1);
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"正 常"')?.n,
    ).toBe(1);
    db.close();
  });

  it('mapping 齐全但 FTS 内容陈旧（原文未切词）时 rebuild 重切', () => {
    const db = setupPost0100Db();
    insertOrphanMessage(db, 'stale1', '登录报错了');
    db.prepare('INSERT INTO messages_fts_rows(message_id) VALUES (?)').run('stale1');
    db.prepare(
      `INSERT INTO messages_fts(rowid, message_id, session_id, role, content)
       SELECT fts_rowid, 'stale1', 's', 'user', '登录报错了'
       FROM messages_fts_rows WHERE message_id = 'stale1'`,
    ).run();
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"登 录"')?.n,
    ).toBe(0);

    migration.run(db);

    expect(
      db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('stale1'),
    ).toEqual({ content: '登 录 报 错 了' });
    expect(
      db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"登 录"')?.n,
    ).toBe(1);
    db.close();
  });

  it('无缺口时零改动（纯检测）', () => {
    const db = setupPost0100Db();
    // 健康库：直接按 TEMP 触发器语义写一条（cjk_seg 化内容）
    insertOrphanMessage(db, 'ok1', '登录报错了');
    db.prepare(
      'INSERT INTO messages_fts_rows(message_id) VALUES (?)',
    ).run('ok1');
    db.prepare(
      `INSERT INTO messages_fts(rowid, message_id, session_id, role, content)
       SELECT fts_rowid, 'ok1', 's', 'user', '登 录 报 错 了'
       FROM messages_fts_rows WHERE message_id = 'ok1'`,
    ).run();

    const rowsBefore = db.prepare(
      'SELECT fts_rowid, message_id FROM messages_fts_rows ORDER BY fts_rowid',
    ).all();
    const ftsBefore = db.prepare(
      'SELECT rowid, message_id, session_id, role, content FROM messages_fts ORDER BY rowid',
    ).all();
    migration.run(db);
    expect(
      db.prepare('SELECT fts_rowid, message_id FROM messages_fts_rows ORDER BY fts_rowid').all(),
    ).toEqual(rowsBefore);
    expect(
      db.prepare('SELECT rowid, message_id, session_id, role, content FROM messages_fts ORDER BY rowid').all(),
    ).toEqual(ftsBefore);
    db.close();
  });

  it('messages_fts_rows 表缺失时 rebuild 后挂 TEMP 触发器，后续 INSERT 按字进 FTS', () => {
    const db = setupPost0100Db();
    insertOrphanMessage(db, 'seed1', '登录报错了');
    db.exec('DROP TABLE messages_fts_rows');
    db.exec('DROP TRIGGER IF EXISTS messages_fts_insert');

    migration.run(db);

    const installed = db.prepare(
      "SELECT count(*) AS n FROM temp.sqlite_master WHERE type='trigger' AND name IN ('messages_fts_insert_cjk','messages_fts_update_cjk')",
    ).get() as { n: number };
    expect(installed.n).toBe(2);
    expect(
      db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('seed1'),
    ).toEqual({ content: '登 录 报 错 了' });
    insertOrphanMessage(db, 'after1', 'foo登录bar');
    expect(
      db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get('after1'),
    ).toEqual({ content: 'foo 登 录 bar' });
    db.close();
  });

  it('messages 表不存在时不抛（全新库链路上由 0100 负责）', () => {
    const db = new Database(':memory:');
    expect(() => migration.run(db)).not.toThrow();
    db.close();
  });
});
