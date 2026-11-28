import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleProxy } from '../client/drizzleProxy';
import type { DbTransport } from '../client/DbTransport';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../client/current.js', () => ({ getDbClient: () => ({ drizzle: state.db, query: async (sql: string, params: unknown[]) => sqlite.prepare(sql).all(...params) }) }));
import { buildAutoUsageProfile, readLocalAutoUsageSamples } from '../../model-groups/autoUsageProfile';
import { localDayKey } from '../dailySpend';
import { getSessionUsageSince, getUsageTaskMeta } from '../dailySessionUsage';

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, provider_id TEXT,
      status TEXT NOT NULL, context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0, user_send_at INTEGER, updated_at INTEGER NOT NULL,
      source TEXT, agent_device_id TEXT
    );
    CREATE TABLE auxiliary_usage_receipts (
      receipt_id TEXT PRIMARY KEY, day TEXT, session_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_create_tokens INTEGER
    );
    CREATE TABLE daily_session_usage (
      day TEXT NOT NULL, session_id TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (day, session_id)
    );
    INSERT INTO sessions VALUES
      ('old', 'Renamed later', 'gpt-5.5', 'openai', 'active', 10, 100, 50, 40, NULL, NULL),
      ('recent', 'Recent', 'claude', NULL, 'archived', 0, 0, NULL, 70, NULL, NULL),
      ('gone', 'Deleted', 'gpt-5.5', NULL, 'deleted', 0, 0, NULL, 80, NULL, NULL),
      ('unused', 'No usage', 'gpt-5.5', NULL, 'active', 0, 0, NULL, 90, NULL, NULL);
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
      source: null,
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

  it.each(['cindy-make', 'cindy-make-merge'])('preserves %s metadata and accounting rows', async (source) => {
    sqlite.prepare('UPDATE sessions SET source = ? WHERE id = ?').run(source, 'recent');
    const usage = await getSessionUsageSince('2026-09-20');
    expect(usage.tasks.find((task) => task.sessionId === 'recent')).toMatchObject({ source });
    expect(usage.rows).toEqual([{ day: '2026-09-25', sessionId: 'recent', tokens: 7 }]);
  });
});

it('adds auxiliary usage only to its real non-deleted task, including receipt-only tasks', async () => {
  sqlite.exec(`INSERT INTO auxiliary_usage_receipts VALUES
    ('a', '2026-09-25', 'recent', 10, 2, 3, NULL),
    ('b', '2026-09-25', 'unused', 20, 1, NULL, NULL),
    ('c', '2026-09-25', 'gone', 999, 1, NULL, NULL),
    ('d', '2026-09-25', NULL, 100, 2, NULL, NULL)`);
  const result = await getSessionUsageSince('2026-09-25');
  expect(result.rows).toEqual(expect.arrayContaining([
    { day: '2026-09-25', sessionId: 'recent', tokens: 22, auxiliaryTokens: 15 },
    { day: '2026-09-25', sessionId: 'unused', tokens: 21, auxiliaryTokens: 21 },
  ]));
  expect(result.rows).toHaveLength(2);
  expect(result.tasks.some(task => task.sessionId === 'unused')).toBe(true);
});

// DB tier: the routing reader must feed each day to the profile. Two days of
// usage on one task used to collapse into the most recent day and its weight.
it('builds the Auto profile with the original days and volume of an ongoing task', async () => {
  const earlier = new Date(2026, 9, 19, 12).getTime();
  const later = new Date(2026, 9, 26, 12).getTime();
  const now = new Date(2026, 9, 27, 12).getTime();
  sqlite.prepare("UPDATE sessions SET updated_at = ?, user_send_at = ? WHERE id = 'old'").run(later, later);
  const insert = sqlite.prepare("INSERT INTO daily_session_usage VALUES (?, 'old', ?, ?)");
  insert.run(localDayKey(earlier), 50_000, earlier);
  insert.run(localDayKey(later), 10_000, later);

  const samples = await readLocalAutoUsageSamples(new Date(2026, 9, 13, 12).getTime(), now);
  expect(samples).toEqual([
    expect.objectContaining({ sessionId: 'old', atMs: earlier, tokens: 50_000 }),
    expect.objectContaining({ sessionId: 'old', atMs: later, tokens: 10_000 }),
  ]);
  const profile = buildAutoUsageProfile(samples, now);
  expect(profile.activeDays).toBe(2);
  expect(profile.byModel.get('gpt-5.5')?.weight).toBeCloseTo(0.4 * (1 + Math.log10(6)) + 1 + Math.log10(2));
});
