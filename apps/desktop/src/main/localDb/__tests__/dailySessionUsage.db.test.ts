import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleProxy } from '../client/drizzleProxy';
import type { DbTransport } from '../client/DbTransport';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../client/current.js', () => ({ getDbClient: () => ({ drizzle: state.db }) }));
import { getSessionUsageSince, getUsageTaskMeta } from '../dailySessionUsage';

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, provider_id TEXT,
      status TEXT NOT NULL, context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0, user_send_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE daily_session_usage (
      day TEXT NOT NULL, session_id TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (day, session_id)
    );
    INSERT INTO sessions VALUES
      ('old', 'Renamed later', 'gpt-5.5', 'openai', 'active', 10, 100, 50, 40),
      ('recent', 'Recent', 'claude', NULL, 'archived', 0, 0, NULL, 70),
      ('gone', 'Deleted', 'gpt-5.5', NULL, 'deleted', 0, 0, NULL, 80),
      ('unused', 'No usage', 'gpt-5.5', NULL, 'active', 0, 0, NULL, 90);
    INSERT INTO daily_session_usage VALUES
      ('2026-09-01', 'old', 5, 1), ('2026-09-01', 'gone', 6, 1),
      ('2026-09-25', 'recent', 7, 1), ('2026-09-25', 'gone', 8, 1);
  `);
  const transport: DbTransport = {
    async send<R>(_op: string, args: unknown): Promise<R> {
      const { sql, params } = args as { sql: string; params: unknown[] };
      return sqlite
        .prepare(sql)
        .raw()
        .all(...params) as R;
    },
    on() {},
    onTerminated() {},
    async close() {},
  };
  state.db = createDrizzleProxy(transport);
});
afterEach(() => sqlite.close());

describe('daily session usage SQL', () => {
  it('returns current metadata for every non-deleted task with usage, regardless of window', async () => {
    const meta = await getUsageTaskMeta();
    expect(meta.map((task) => task.sessionId).sort()).toEqual(['old', 'recent']);
    expect(meta.find((task) => task.sessionId === 'old')).toEqual({
      sessionId: 'old',
      title: 'Renamed later',
      model: 'gpt-5.5',
      providerId: 'openai',
      contextTokens: 10,
      contextWindow: 100,
      lastActiveAt: 50,
    });
  });

  it('limits rows to the window but keeps the full task set', async () => {
    const usage = await getSessionUsageSince('2026-09-20');
    expect(usage.rows).toEqual([{ day: '2026-09-25', sessionId: 'recent', tokens: 7 }]);
    expect(usage.tasks.map((task) => task.sessionId).sort()).toEqual(['old', 'recent']);
  });
});
