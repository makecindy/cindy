import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sqlite: null as Database.Database | null }));

vi.mock('../client/current.js', () => ({
  getDbClient: () => ({
    queryOne: async <T,>(sql: string, args: unknown[] = []) => h.sqlite!.prepare(sql).get(...args) as T | undefined,
    query: async <T,>(sql: string, args: unknown[] = []) => h.sqlite!.prepare(sql).all(...args) as T[],
  }),
}));

import { resolveBotHistorySessionIds } from '../botHistoryScope.js';

beforeEach(() => {
  h.sqlite = new Database(':memory:');
  h.sqlite.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE bot_session_links (session_id TEXT, bot_id TEXT, created_at INTEGER);
    CREATE TABLE bot_delegations (requesting_bot_id TEXT, child_session_id TEXT, created_at INTEGER);
    INSERT INTO sessions VALUES ('bot-main', 'bot'), ('owner-task', 'desktop'), ('child-1', 'desktop');
    INSERT INTO bot_session_links VALUES ('bot-main', 'bot-1', 1), ('other-bot-main', 'bot-2', 2);
    INSERT INTO bot_delegations VALUES ('bot-1', 'child-1', 3), ('bot-1', NULL, 4), ('bot-2', 'child-2', 5);
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
