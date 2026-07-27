import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as schema from '../schema';
import type { DbClient } from '../client/DbClient';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import { incrementDailySpend, localDayKey } from '../dailySpend';
import { incrementDailyModelUsage } from '../dailyModelUsage';

const DDL = `
  CREATE TABLE daily_spend (
    day TEXT PRIMARY KEY NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_amount REAL NOT NULL DEFAULT 0,
    cost_currency TEXT,
    cost_is_approximate INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE daily_model_usage (
    day TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_amount REAL NOT NULL DEFAULT 0,
    cost_currency TEXT,
    cost_is_approximate INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_create_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, agent_kind, model)
  );
`;

function createHarness() {
  const sqlite = new Database(':memory:');
  sqlite.exec(DDL);
  const db = drizzle(sqlite, { schema });
  const dbClient = { drizzle: db } as unknown as DbClient;
  setCurrentDbClient(dbClient, 'test-user');
  return {
    sqlite,
    dbClient,
    close: () => {
      clearCurrentDbClient(dbClient);
      sqlite.close();
    },
  };
}

const usd = (amount: number) => ({
  amount,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
});

const cny = (amount: number) => ({
  amount,
  currency: 'CNY' as const,
  approximate: false,
  kind: 'actual-cost' as const,
});

describe('daily ledgers degrade gracefully on currency conflict', () => {
  it('daily spend keeps the existing currency and drops the conflicting amount without throwing', async () => {
    const harness = createHarness();
    try {
      await incrementDailySpend(usd(1.5));
      const result = await incrementDailySpend(cny(10));
      expect(result.money).toMatchObject({ amount: 1.5, currency: 'USD' });
      const row = harness.sqlite
        .prepare('SELECT cost_amount, cost_currency FROM daily_spend')
        .get() as { cost_amount: number; cost_currency: string };
      expect(row).toEqual({ cost_amount: 1.5, cost_currency: 'USD' });
    } finally {
      harness.close();
    }
  });

  it('daily model usage still records token deltas when the money currency conflicts', async () => {
    const harness = createHarness();
    try {
      await incrementDailyModelUsage({
        agentKind: 'claude-code',
        model: 'claude-opus-4-8',
        money: usd(2),
        inputTokensDelta: 100,
        outputTokensDelta: 10,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      });
      await expect(
        incrementDailyModelUsage({
          agentKind: 'claude-code',
          model: 'claude-opus-4-8',
          money: cny(13.4),
          inputTokensDelta: 50,
          outputTokensDelta: 5,
          cacheReadTokensDelta: 7,
          cacheCreateTokensDelta: 0,
        }),
      ).resolves.toBeUndefined();

      const row = harness.sqlite
        .prepare(
          `SELECT cost_amount, cost_currency, input_tokens, output_tokens, cache_read_tokens
           FROM daily_model_usage WHERE day = ?`,
        )
        .get(localDayKey()) as {
        cost_amount: number;
        cost_currency: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
      };
      expect(row.cost_currency).toBe('USD');
      expect(row.cost_amount).toBe(2);
      expect(row.input_tokens).toBe(150);
      expect(row.output_tokens).toBe(15);
      expect(row.cache_read_tokens).toBe(7);
    } finally {
      harness.close();
    }
  });

  it('daily model usage conflict with zero token deltas is a no-op', async () => {
    const harness = createHarness();
    try {
      await incrementDailyModelUsage({
        agentKind: 'codex',
        model: 'gpt-5.5',
        money: usd(1),
        inputTokensDelta: 1,
        outputTokensDelta: 0,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      });
      await incrementDailyModelUsage({
        agentKind: 'codex',
        model: 'gpt-5.5',
        money: cny(6.7),
        inputTokensDelta: 0,
        outputTokensDelta: 0,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      });
      const row = harness.sqlite
        .prepare('SELECT cost_amount, input_tokens FROM daily_model_usage')
        .get() as { cost_amount: number; input_tokens: number };
      expect(row).toEqual({ cost_amount: 1, input_tokens: 1 });
    } finally {
      harness.close();
    }
  });
});
