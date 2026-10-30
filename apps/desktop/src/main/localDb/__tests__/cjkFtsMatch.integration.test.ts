import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { buildMessagesFtsMatch } from '../chatHistorySearch.pure';
import { cjkSeg } from '../cjkSeg';
import { registerCjkSeg } from '../registerCjkSeg';

function setup() {
  const db = new Database(':memory:');
  registerCjkSeg(db);
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      message_id UNINDEXED, session_id UNINDEXED, role UNINDEXED, content,
      tokenize='porter unicode61'
    );
  `);
  return db;
}

function add(db: Database.Database, id: string, content: string) {
  db.prepare('INSERT INTO messages_fts(message_id, session_id, role, content) VALUES (?,?,?,?)').run(
    id,
    's',
    'user',
    cjkSeg(content),
  );
}

function matchIds(db: Database.Database, query: string): string[] {
  const match = buildMessagesFtsMatch(query);
  if (!match) return [];
  return db
    .prepare('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY message_id')
    .all(match)
    .map((row) => String((row as { message_id: string }).message_id));
}

describe('messages_fts CJK match integration', () => {
  it('汉字与 Latin/数字相邻时仍能按字召回', () => {
    const db = setup();
    add(db, 'm1', 'foo登录bar');
    add(db, 'm2', 'login报错');
    add(db, 'm3', '登录报错了');
    expect(db.prepare('SELECT message_id, content FROM messages_fts ORDER BY message_id').all()).toEqual([
      { message_id: 'm1', content: 'foo 登 录 bar' },
      { message_id: 'm2', content: 'login 报 错' },
      { message_id: 'm3', content: '登 录 报 错 了' },
    ]);
    expect(matchIds(db, '登录')).toEqual(['m1', 'm3']);
    expect(matchIds(db, '报错')).toEqual(['m2', 'm3']);
    expect(matchIds(db, 'login报错')).toEqual(['m2']);
    expect(matchIds(db, 'login')).toEqual(['m2']);
    db.close();
  });

  it('侧栏默认 OR 最大化召回；session_search 的 AND 要求全部命中', () => {
    const db = setup();
    add(db, 'a', '请先登录再提交');
    add(db, 'b', '报错了但没有登录');
    add(db, 'c', 'login timeout');
    add(db, 'd', 'fix the login crash now');
    expect(buildMessagesFtsMatch('login crash')).toBe('"login" OR "crash"');
    expect(matchIds(db, 'login crash')).toEqual(['c', 'd']);
    expect(matchIds(db, '登录 报错')).toEqual(['a', 'b']);
    expect(buildMessagesFtsMatch('login crash', 'AND')).toBe('"login" AND "crash"');
    expect(
      db
        .prepare('SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY message_id')
        .all(buildMessagesFtsMatch('login crash', 'AND'))
        .map((row) => String((row as { message_id: string }).message_id)),
    ).toEqual(['d']);
    expect(matchIds(db, '登录')).toEqual(['a', 'b']);
    expect(matchIds(db, 'login')).toEqual(['c', 'd']);
    db.close();
  });
});
