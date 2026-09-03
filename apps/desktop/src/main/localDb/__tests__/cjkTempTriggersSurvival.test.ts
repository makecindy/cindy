import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cjkFtsTempTriggersInstalled,
  createMessagesFtsPersistentTriggers,
  ensureCjkFtsTempTriggersInstalled,
  registerCjkSeg,
} from '../registerCjkSeg';

/**
 * #3841 回归：`PRAGMA temp_store = MEMORY` 会按 SQLite 文档化语义立即删除连接上
 * 所有已存在的 TEMP 对象。createWorkerDatabase / createDatabase 曾经把
 * registerCjkSeg（挂 TEMP 触发器）排在 applyPragmas（含 temp_store=MEMORY）之前，
 * 触发器被原地清空且无报错，持久触发器又因函数守卫同时跳过 → 增量写入静默漏 FTS
 * （用户侧表现为升级后侧栏搜索按内容完全打不中新消息）。
 *
 * 这组测试锁定两条不变量：
 *  1. 先 pragma 后挂载 → TEMP 触发器必须存活并能拦到 INSERT（写入进 FTS）；
 *  2. 先挂载后 pragma（错误顺序）→ ensureCjkFtsTempTriggersInstalled 必须能自愈。
 */

function setupRealMessageSchema(): { db: Database.Database; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `cjk-trig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      created_at INTEGER NOT NULL,
      agent_meta TEXT,
      rewind_at INTEGER,
      agent_kind TEXT
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content,
      tokenize='porter unicode61'
    );
    CREATE TABLE messages_fts_rows (
      fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      message_id TEXT NOT NULL
    );
    CREATE UNIQUE INDEX messages_fts_rows_message_id_idx ON messages_fts_rows(message_id);
  `);
  return { db, dbPath };
}

function insertMessage(db: Database.Database, id: string, content: string): void {
  db.prepare(
    "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, 's', 'user', ?, 1788417088581)",
  ).run(id, `${id}-c`, content);
}

function ftsRow(db: Database.Database, id: string): { content: string } | undefined {
  return db.prepare('SELECT content FROM messages_fts WHERE message_id = ?').get(id) as
    | { content: string }
    | undefined;
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(p + suffix);
      } catch {
        /* 文件不存在忽略 */
      }
    }
  }
});

describe('cjk TEMP trigger survival (#3841)', () => {
  it('正确顺序（pragma 先行 → registerCjkSeg）下 TEMP 触发器存活且拦截 INSERT', () => {
    const { db, dbPath } = setupRealMessageSchema();
    tempPaths.push(dbPath);
    // 复刻 createWorkerDatabase 修复后的顺序
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');
    db.pragma('cache_size = -65536');
    db.pragma('busy_timeout = 5000');
    registerCjkSeg(db);
    expect(cjkFtsTempTriggersInstalled(db)).toBe(true);

    insertMessage(db, 'm1', '登录报错了');
    expect(ftsRow(db, 'm1')?.content).toBe('登 录 报 错 了');
    expect(
      (db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get('"登 录"') as { n: number } | undefined)?.n,
    ).toBe(1);
    db.close();
  });

  it('错误顺序（registerCjkSeg 先行 → temp_store pragma）后 ensure 自愈重挂', () => {
    const { db, dbPath } = setupRealMessageSchema();
    tempPaths.push(dbPath);
    // 复刻修复前的错误顺序：先挂载，再跑会真正发生值切换的 temp_store pragma。
    // 先显式 FILE，保证从 FILE→MEMORY 发生 transition（默认已是 MEMORY 时
    // 再设 MEMORY 不会删 TEMP 对象，测试就会失去复现能力）。
    db.pragma('temp_store = FILE');
    registerCjkSeg(db);
    expect(cjkFtsTempTriggersInstalled(db)).toBe(true);
    db.pragma('temp_store = MEMORY');
    // SQLite 文档化行为：触发器已被立即删除
    expect(cjkFtsTempTriggersInstalled(db)).toBe(false);

    // 收口自愈：重挂后触发器恢复，后续写入进 FTS
    ensureCjkFtsTempTriggersInstalled(db);
    expect(cjkFtsTempTriggersInstalled(db)).toBe(true);
    insertMessage(db, 'm2', 'foo登录bar');
    expect(ftsRow(db, 'm2')?.content).toBe('foo 登 录 bar');
    db.close();
  });

  it('TEMP 触发器缺失时 ensure 可重挂，连续调用幂等', () => {
    const { db, dbPath } = setupRealMessageSchema();
    tempPaths.push(dbPath);
    registerCjkSeg(db);
    db.exec('DROP TRIGGER IF EXISTS temp.messages_fts_insert_cjk');
    db.exec('DROP TRIGGER IF EXISTS temp.messages_fts_update_cjk');
    expect(cjkFtsTempTriggersInstalled(db)).toBe(false);
    expect(() => ensureCjkFtsTempTriggersInstalled(db)).not.toThrow();
    expect(cjkFtsTempTriggersInstalled(db)).toBe(true);
    expect(() => ensureCjkFtsTempTriggersInstalled(db)).not.toThrow();
    expect(cjkFtsTempTriggersInstalled(db)).toBe(true);
    db.close();
  });

  it('未注册 cjk_seg 的连接写入消息不报错（旧客户端回退兼容不变量）', () => {
    const { db, dbPath } = setupRealMessageSchema();
    tempPaths.push(dbPath);
    // 不注册 cjk_seg，走生产 helper 建完整持久触发器（写原文 + 函数守卫）
    createMessagesFtsPersistentTriggers(db);
    expect(() => insertMessage(db, 'm3', '边界')).not.toThrow();
    // 守卫通过（函数缺失）→ 持久触发器写【原文】进 FTS：旧客户端自己的搜索仍可用，
    // 主表消息落库。内容保持未分词的 '边界'（不是新客户端的 '边 界'）。
    expect((db.prepare("SELECT count(*) AS n FROM messages WHERE id='m3'").get() as { n: number } | undefined)?.n).toBe(1);
    expect(ftsRow(db, 'm3')?.content).toBe('边界');
    db.close();
  });
});
