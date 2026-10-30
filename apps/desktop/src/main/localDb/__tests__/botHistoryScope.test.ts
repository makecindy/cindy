import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));

vi.mock('../client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async <T,>(sql: string, args: unknown[] = []) => h.sqlite!.prepare(sql).get(...args) as T | undefined,
    query: async <T,>(sql: string, args: unknown[] = []) => h.sqlite!.prepare(sql).all(...args) as T[],
  }),
}));

import { listBotRecallSessionIds, resolveBotHistorySessionIds } from '../botHistoryScope.js';

beforeEach(() => {
  h.sqlite = new Database(':memory:');
  h.sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, created_at INTEGER, role TEXT NOT NULL DEFAULT 'canonical', route_key TEXT);
    CREATE TABLE bot_delegations (requesting_bot_id TEXT, child_session_id TEXT, created_at INTEGER, target_bot_id TEXT);
    INSERT INTO sessions VALUES ('bot-main', 'bot'), ('owner-task', 'desktop'), ('child-1', 'desktop');
    INSERT INTO bot_session_links (session_id, bot_id, created_at) VALUES ('bot-main', 'bot-1', 1), ('other-bot-main', 'bot-2', 2);
    INSERT INTO bot_delegations (requesting_bot_id, child_session_id, created_at) VALUES ('bot-1', 'child-1', 3), ('bot-1', NULL, 4), ('bot-2', 'child-2', 5);
  `);
});
afterEach(() => h.sqlite?.close());

describe('resolveBotHistorySessionIds', () => {
  it('scopes a Bot to its own sessions plus the background tasks it started', async () => {
    expect(await resolveBotHistorySessionIds('bot-main', undefined)).toEqual(['child-1', 'bot-main']);
  });

  it('leaves ordinary tasks unscoped and fails closed for unknown callers', async () => {
    expect(await resolveBotHistorySessionIds('owner-task', undefined)).toBeNull();
    expect(await resolveBotHistorySessionIds('missing', undefined)).toEqual([]);
  });
});

describe('listBotRecallSessionIds', () => {
  it('keeps every chat session ahead of background tasks within the bound, newest first', async () => {
    // 恢复前的旧对话(更早)+ 当前对话,再加一堆比它们都新的后台任务;群专线、受派任务
    // (含完成后转成 history 的,无论 bot_delegations 行还在不在)都不是私聊,哪怕更新也不进清单。
    h.sqlite!.exec(`
      INSERT INTO bot_session_links (session_id, bot_id, created_at, role, route_key) VALUES
        ('bot-main-old', 'bot-1', 0, 'history', NULL),
        ('bot-group-lane', 'bot-1', 20, 'group', 'group:g1'),
        ('bot-received-live', 'bot-1', 21, 'delegation', 'delegation:d1'),
        ('bot-received-done', 'bot-1', 22, 'history', NULL),
        ('bot-received-orphan', 'bot-1', 23, 'history', 'delegation:d3');
      INSERT INTO bot_delegations (requesting_bot_id, child_session_id, created_at, target_bot_id) VALUES
        ('bot-2', 'bot-received-live', 21, 'bot-1'),
        ('bot-2', 'bot-received-done', 22, 'bot-1');
      ${Array.from({ length: 6 }, (_, i) => `INSERT INTO bot_delegations (requesting_bot_id, child_session_id, created_at) VALUES ('bot-1', 'task-${i}', ${10 + i});`).join('\n')}
    `);
    expect(await listBotRecallSessionIds('bot-main', 4)).toEqual({
      sessionIds: ['bot-main', 'bot-main-old', 'task-5', 'task-4'],
      chatsTruncated: false,
    });
    // 名额够时全部带上;非伙伴 / 未知调用方 / 零名额都为空。
    expect(await listBotRecallSessionIds('bot-main', 50)).toEqual({
      sessionIds: ['bot-main', 'bot-main-old', 'task-5', 'task-4', 'task-3', 'task-2', 'task-1', 'task-0', 'child-1'],
      chatsTruncated: false,
    });
    expect(await listBotRecallSessionIds('owner-task', 4)).toEqual({ sessionIds: [], chatsTruncated: false });
    expect(await listBotRecallSessionIds('missing', 4)).toEqual({ sessionIds: [], chatsTruncated: false });
    expect(await listBotRecallSessionIds('bot-main', 0)).toEqual({ sessionIds: [], chatsTruncated: false });
    // 私聊比名额多:只放最新的,并如实标记没放全(后台任务一个都不占名额)。
    expect(await listBotRecallSessionIds('bot-main', 1)).toEqual({ sessionIds: ['bot-main'], chatsTruncated: true });
  });
});
