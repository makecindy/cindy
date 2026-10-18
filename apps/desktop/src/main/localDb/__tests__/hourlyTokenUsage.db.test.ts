import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrizzleProxy } from '../client/drizzleProxy';
import type { DbTransport } from '../client/DbTransport';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../client/current.js', () => ({
  getDbClient: () => ({ drizzle: state.db }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { incrementDailyModelUsage } from '../dailyModelUsage';
import { getHourlyTokenUsageSince } from '../hourlyTokenUsage';

let sqlite: Database.Database;
const stamp = (hour: number, day = 16) => new Date(2026, 9, day, hour, 30).getTime();
const delta = {
  agentKind: 'codex' as const,
  model: 'fixture',
  inputTokensDelta: 10,
  outputTokensDelta: 20,
  cacheReadTokensDelta: 30,
  cacheCreateTokensDelta: 40,
};

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE daily_model_usage (
    day TEXT NOT NULL, agent_kind TEXT NOT NULL, model TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0, cost_amount REAL NOT NULL DEFAULT 0,
    cost_currency TEXT NOT NULL DEFAULT 'USD', cost_is_approximate INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_create_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL, PRIMARY KEY(day, agent_kind, model, cost_currency)
  );
  INSERT INTO daily_model_usage(day, agent_kind, model, input_tokens, updated_at)
    VALUES('2026-10-15', 'codex', 'old', 1000, 1);`);
  const dir = path.resolve(__dirname, '../../../../drizzle');
  const migration = readdirSync(dir).find((name) => name.endsWith('_hourly_token_usage.sql'));
  if (!migration) throw new Error('Generated hourly usage migration is missing');
  sqlite.exec(readFileSync(path.join(dir, migration), 'utf8'));
  const transport: DbTransport = {
    async send<R>(op: string, args: unknown): Promise<R> {
      const { sql, params } = args as { sql: string; params: unknown[] };
      const stmt = sqlite.prepare(sql);
      return (op === 'run' ? stmt.run(...params) : stmt.raw().all(...params)) as R;
    },
    on() {},
    onTerminated() {},
    async close() {},
  };
  state.db = createDrizzleProxy(transport);
});
afterEach(() => sqlite.close());

describe('hourly usage ledger', () => {
  it('starts without backfill and records real daily inserts and upserts in their local hour', async () => {
    expect(await getHourlyTokenUsageSince('0000-01-01')).toEqual([]);
    await incrementDailyModelUsage(delta, stamp(8));
    await incrementDailyModelUsage(delta, stamp(8));
    await incrementDailyModelUsage({ ...delta, model: 'other' }, stamp(9));
    await incrementDailyModelUsage(delta, stamp(0, 17));
    expect(await getHourlyTokenUsageSince('2026-10-16')).toEqual([
      { day: '2026-10-16', hour: 8, tokens: 200 },
      { day: '2026-10-16', hour: 9, tokens: 100 },
      { day: '2026-10-17', hour: 0, tokens: 100 },
    ]);
    expect(await getHourlyTokenUsageSince('2026-10-17')).toEqual([
      { day: '2026-10-17', hour: 0, tokens: 100 },
    ]);
  });

  it('counts only the increment when an existing model crosses into another hour', async () => {
    await incrementDailyModelUsage(delta, stamp(8));
    await incrementDailyModelUsage(delta, stamp(9));
    expect(await getHourlyTokenUsageSince('2026-10-16')).toEqual([
      { day: '2026-10-16', hour: 8, tokens: 100 },
      { day: '2026-10-16', hour: 9, tokens: 100 },
    ]);
    const daily = sqlite
      .prepare(
        'SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS tokens FROM daily_model_usage WHERE day = ?',
      )
      .get('2026-10-16');
    expect(daily).toEqual({ tokens: 200 });
  });

  it('does not create hourly records for cost-only or empty writes', async () => {
    const empty = {
      ...delta,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      cacheReadTokensDelta: 0,
      cacheCreateTokensDelta: 0,
    };
    await incrementDailyModelUsage(empty, stamp(8));
    await incrementDailyModelUsage(
      {
        ...empty,
        money: {
          amount: 1,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      },
      stamp(8),
    );
    await incrementDailyModelUsage(
      {
        ...empty,
        money: {
          amount: 1,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      },
      stamp(9),
    );
    expect(await getHourlyTokenUsageSince('0000-01-01')).toEqual([]);
  });

  it('rolls hourly and daily writes back together, including a failed hourly insert', async () => {
    sqlite.exec('BEGIN');
    await incrementDailyModelUsage(delta, stamp(8));
    sqlite.exec('ROLLBACK');
    expect(await getHourlyTokenUsageSince('2026-10-16')).toEqual([]);
    sqlite.exec(
      `CREATE TRIGGER fail_hourly BEFORE INSERT ON hourly_token_usage BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`,
    );
    await expect(incrementDailyModelUsage(delta, stamp(8))).rejects.toThrow('fixture failure');
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM daily_model_usage WHERE day = ?').get('2026-10-16'),
    ).toEqual({ n: 0 });
    expect(await getHourlyTokenUsageSince('2026-10-16')).toEqual([]);
  });
});
