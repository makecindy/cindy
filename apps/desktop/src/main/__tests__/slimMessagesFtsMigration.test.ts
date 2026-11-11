import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Production keeps migration helpers CommonJS; Vitest loads the TS helper through
// its transformer and consumes the CommonJS default export.
const { default: migration } = (await import('../../../drizzle/scripts/0066_slim_messages_fts')) as {
  default: { run: (db: Database.Database) => void };
};

/** 0017 形态的最小 messages 表 + 旧版全量 FTS(insert 触发器无 role 过滤)。 */
function setupLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
    CREATE TRIGGER messages_fts_insert
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL
    BEGIN
      INSERT INTO messages_fts(message_id, session_id, role, content)
        VALUES (new.id, new.session_id, new.role, new.content);
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
    'INSERT INTO messages (id, session_id, role, content, rewind_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 's1', role, content, rewindAt);
}

function ftsMessageIds(db: Database.Database): string[] {
  return db
    .prepare('SELECT message_id FROM messages_fts ORDER BY message_id')
    .all()
    .map((r) => String((r as { message_id: unknown }).message_id));
}

describe('0066 slim messages_fts migration', () => {
  it('回填只保留白名单 role,tool_result/tool_use/thinking 被清出索引', () => {
    const db = setupLegacyDb();
    insertMessage(db, 'm-user', 'user', '怎么修备份');
    insertMessage(db, 'm-assistant', 'assistant', '先看磁盘');
    insertMessage(db, 'm-ask', 'ask_user', '要继续吗');
    insertMessage(db, 'm-plan', 'plan_review', '计划内容');
    insertMessage(db, 'm-tool-result', 'tool_result', 'rg 输出 '.repeat(100));
    insertMessage(db, 'm-tool-use', 'tool_use', '{"cmd":"rg"}');
    insertMessage(db, 'm-thinking', 'thinking', '内心戏');
    // 旧触发器无 role 过滤 → 迁移前 7 条全在索引里
    expect(ftsMessageIds(db)).toHaveLength(7);

    migration.run(db);

    expect(ftsMessageIds(db)).toEqual(['m-ask', 'm-assistant', 'm-plan', 'm-user']);
    db.close();
  });

  it('回填跳过 rewind 软删行', () => {
    const db = setupLegacyDb();
    insertMessage(db, 'm-live', 'user', '还在的');
    insertMessage(db, 'm-rewound', 'user', '被回退的', 123);
    migration.run(db);
    expect(ftsMessageIds(db)).toEqual(['m-live']);
    db.close();
  });

  it('新触发器:白名单 role 正常同步,工具输出不再进索引', () => {
    const db = setupLegacyDb();
    migration.run(db);

    insertMessage(db, 'm-new-user', 'user', '新消息');
    insertMessage(db, 'm-new-tool', 'tool_result', '超大输出');
    expect(ftsMessageIds(db)).toEqual(['m-new-user']);

    // update 触发器:改内容跟随;role 在白名单外的行 update 后也不会混进来
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('改过了', 'm-new-user');
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('也改了', 'm-new-tool');
    expect(ftsMessageIds(db)).toEqual(['m-new-user']);
    const content = db
      .prepare('SELECT content FROM messages_fts WHERE message_id = ?')
      .get('m-new-user') as { content: string };
    expect(content.content).toBe('改过了');

    // rewind 软删(置 rewind_at)→ update 触发器把它移出索引
    db.prepare('UPDATE messages SET rewind_at = 1 WHERE id = ?').run('m-new-user');
    expect(ftsMessageIds(db)).toEqual([]);

    // delete 触发器仍然生效
    insertMessage(db, 'm-del', 'user', '要删的');
    db.prepare('DELETE FROM messages WHERE id = ?').run('m-del');
    expect(ftsMessageIds(db)).toEqual([]);
    db.close();
  });

  it('幂等:重复执行安全', () => {
    const db = setupLegacyDb();
    insertMessage(db, 'm1', 'user', 'hello');
    migration.run(db);
    migration.run(db);
    expect(ftsMessageIds(db)).toEqual(['m1']);
    db.close();
  });

  it('messages 表不存在(最小 fixture 库)→ 整段跳过不报错', () => {
    const db = new Database(':memory:');
    expect(() => migration.run(db)).not.toThrow();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get(),
    ).toBeUndefined();
    db.close();
  });
});
