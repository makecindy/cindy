import type Database from 'better-sqlite3';

import { CJK_SEG_SQL_FN, cjkSeg } from './cjkSeg';

const FTS_ROLE_WHITELIST = "('user', 'assistant', 'ask_user', 'plan_review')";
const CJK_SEG_FUNCTION_GUARD = `NOT EXISTS (SELECT 1 FROM pragma_function_list WHERE name='${CJK_SEG_SQL_FN}')`;

/**
 * 每个新客户端写 `messages` 的连接都必须先注册 `cjk_seg`，再挂 TEMP 触发器。
 * 持久触发器只写原文、且 WHEN 看到已注册函数时跳过，所以旧客户端漏注册仍能插入，
 * 只是新行不再按字切。注册必须幂等，重复打开连接不能抛。
 */
export function registerCjkSeg(db: Database.Database): void {
  db.function(CJK_SEG_SQL_FN, { deterministic: true }, (value: unknown) => cjkSeg(value));
  installCjkSegTempTriggers(db);
}

export function assertCjkSegRegistered(db: Database.Database): void {
  const row = db.prepare(`SELECT ${CJK_SEG_SQL_FN}(?) AS v`).get('探针') as { v: string };
  if (row?.v !== '探 针') {
    throw new Error(`${CJK_SEG_SQL_FN} probe failed: expected '探 针', got ${JSON.stringify(row?.v)}`);
  }
}

const CJK_TEMP_TRIGGER_NAMES = ['messages_fts_insert_cjk', 'messages_fts_update_cjk'] as const;

/** TEMP 触发器当前是否都挂在连接上（temp schema 里两个名字都在）。 */
export function cjkFtsTempTriggersInstalled(db: Database.Database): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM temp.sqlite_master WHERE type='trigger' AND name IN (${CJK_TEMP_TRIGGER_NAMES.map(() => '?').join(',')})`,
    )
    .all(...CJK_TEMP_TRIGGER_NAMES) as Array<{ name: string }>;
  return rows.length === CJK_TEMP_TRIGGER_NAMES.length;
}

/**
 * 挂载链收口：确保 TEMP 触发器真的在连接上并存活。
 *
 * 背景（#3841）：`PRAGMA temp_store` 一旦在挂载之后执行，SQLite 会按文档化语义
 * "immediately delete all existing temporary tables, indices, triggers, and views"，
 * 刚挂的 TEMP 触发器会被原地清空且无任何报错（持久触发器因函数守卫同时跳过 →
 * 增量写入静默漏 FTS）。所以调用方必须保证：任何 `temp_store` 相关 pragma 都在
 * `registerCjkSeg` 之前执行；本函数作为最后一道防线再验一次，不在就重挂一次，
 * 仍不在则抛错拒绝带病启动——宁可 init 失败也不能静默漏写聊天索引。
 */
export function ensureCjkFtsTempTriggersInstalled(db: Database.Database): void {
  if (!tableExists(db, 'messages') || !tableExists(db, 'messages_fts') || !tableExists(db, 'messages_fts_rows')) {
    return;
  }
  if (cjkFtsTempTriggersInstalled(db)) return;
  installCjkSegTempTriggers(db);
  if (!cjkFtsTempTriggersInstalled(db)) {
    throw new Error(
      'cjk_seg temp triggers failed to install after retry; refusing to start with a silently-unindexed messages table (#3841)',
    );
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

/**
 * 连接级 TEMP 触发器：新客户端按字写入 FTS。同名 TEMP 不会覆盖持久触发器，
 * 两者都会 fire，所以持久 insert/update 必须用 `cjk_seg` 函数存在性守卫跳过。
 * TEMP 对象不进库文件，旧连接看不到它们。
 */
export function installCjkSegTempTriggers(db: Database.Database): void {
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
        SELECT fts_rowid, new.id, new.session_id, new.role, ${CJK_SEG_SQL_FN}(new.content)
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
        SELECT fts_rowid, new.id, new.session_id, new.role, ${CJK_SEG_SQL_FN}(new.content)
        FROM messages_fts_rows
        WHERE message_id = new.id
          AND new.rewind_at IS NULL
          AND new.role IN ${FTS_ROLE_WHITELIST};
    END;
  `);
}

/** 持久触发器写原文；已注册 `cjk_seg` 的连接由 TEMP 触发器接管 insert/update。 */
export function createMessagesFtsPersistentTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER messages_fts_insert
    AFTER INSERT ON messages
    WHEN new.rewind_at IS NULL AND new.role IN ${FTS_ROLE_WHITELIST}
      AND ${CJK_SEG_FUNCTION_GUARD}
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
      AND ${CJK_SEG_FUNCTION_GUARD}
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
