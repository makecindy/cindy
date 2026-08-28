import type Database from 'better-sqlite3';

import { CJK_SEG_SQL_FN, cjkSeg } from './cjkSeg';

/**
 * 每个会写 messages 的连接都必须先注册 `cjk_seg`：触发器一旦引用该函数，
 * 漏注册会让插入消息直接报 `no such function`，聊天记录持久化失败。
 * 注册必须幂等，重复打开连接不能抛。
 */
export function registerCjkSeg(db: Database.Database): void {
  db.function(CJK_SEG_SQL_FN, { deterministic: true }, (value: unknown) => cjkSeg(value));
}

export function assertCjkSegRegistered(db: Database.Database): void {
  const row = db.prepare(`SELECT ${CJK_SEG_SQL_FN}(?) AS v`).get('探针') as { v: string };
  if (row?.v !== '探 针') {
    throw new Error(`${CJK_SEG_SQL_FN} probe failed: expected '探 针', got ${JSON.stringify(row?.v)}`);
  }
}
