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

// 历史汇总使用下方注入的只读依赖，不加载账号报价缓存及其外部服务。
vi.mock('../../usage/modelPricing', () => ({
  getGatewayModelPricing: vi.fn(),
  isModelPricingRefreshInFlight: vi.fn(),
}));
vi.mock('../../usage/referenceModelPricing', () => ({
  getReferenceModelPricing: vi.fn(),
  readModelPriceOverridesSnapshot: vi.fn(),
}));

import * as schema from '../schema';
import type { DbClient } from '../client/DbClient';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import {
  collapseDayMonies,
  getAllSpendDays,
  getTodaySpend,
  incrementDailySpend,
  localDayKey,
} from '../dailySpend';
import { incrementDailyModelUsage } from '../dailyModelUsage';
import { readUsageHistoryWith } from '../../usage/usageHistory';
import { USD_TO_CNY_FIXED_RATE } from '../../../shared/regionalMoney';
import {
  __resetActiveLedgerCurrencyForTesting,
  setActiveLedgerCurrency,
} from '../../usage/ledgerCurrency';

const DDL = `
  CREATE TABLE daily_spend (
    day TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_amount REAL NOT NULL DEFAULT 0,
    cost_currency TEXT NOT NULL DEFAULT 'USD',
    cost_is_approximate INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, cost_currency)
  );
  CREATE TABLE daily_model_usage (
    day TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    cost_amount REAL NOT NULL DEFAULT 0,
    cost_currency TEXT NOT NULL DEFAULT 'USD',
    cost_is_approximate INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_create_tokens INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, agent_kind, model, cost_currency)
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
      __resetActiveLedgerCurrencyForTesting();
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

describe('daily ledger multi-currency rows', () => {
  it('never overwrites an existing day total when the ledger currency flips', async () => {
    // 回归护栏。此前 daily_spend 一天只有一行、币种冲突时直接用新金额覆盖旧累计,
    // 于是账本币种每翻转一次(换号、跨租户、上游漏发 currency)就静默丢掉当天已记的
    // 全部花费 —— 实测一天内翻转多次,首页"今日花费"被反复清零。
    const harness = createHarness();
    try {
      setActiveLedgerCurrency('CNY');
      await incrementDailySpend(cny(149.13));
      setActiveLedgerCurrency('USD');
      await incrementDailySpend(usd(15.44));

      const rows = harness.sqlite
        .prepare('SELECT cost_currency, cost_amount FROM daily_spend ORDER BY cost_currency')
        .all() as Array<{ cost_currency: string; cost_amount: number }>;
      expect(rows).toEqual([
        { cost_currency: 'CNY', cost_amount: 149.13 },
        { cost_currency: 'USD', cost_amount: 15.44 },
      ]);
    } finally {
      harness.close();
    }
  });

  it('keeps accumulating within each currency instead of restarting', async () => {
    const harness = createHarness();
    try {
      setActiveLedgerCurrency('USD');
      await incrementDailySpend(usd(1.5));
      setActiveLedgerCurrency('CNY');
      await incrementDailySpend(cny(10));
      setActiveLedgerCurrency('USD');
      await incrementDailySpend(usd(2.5));

      const rows = harness.sqlite
        .prepare('SELECT cost_currency, cost_amount FROM daily_spend ORDER BY cost_currency')
        .all() as Array<{ cost_currency: string; cost_amount: number }>;
      expect(rows).toEqual([
        { cost_currency: 'CNY', cost_amount: 10 },
        { cost_currency: 'USD', cost_amount: 4 },
      ]);
    } finally {
      harness.close();
    }
  });

  // 单测（内存 SQLite）：同一天切换结算币种后，今日金额和历史汇总必须一致。
  // 既有覆盖只检查各币种独立写入，未比较今日读取、写入回执与真实历史聚合入口。
  // 最小输入：USD 4 + CNY 10；读取不得改库，后续增量也只写入原币种行。
  it.each(['CNY', 'USD'] as const)('aligns today reads and write receipts with history for a %s ledger without converting stored rows', async (currency) => {
    const harness = createHarness();
    try {
      setActiveLedgerCurrency('USD');
      await incrementDailySpend(usd(4));
      setActiveLedgerCurrency('CNY');
      await incrementDailySpend(cny(10));
      setActiveLedgerCurrency(currency);

      const rawRows = () => harness.sqlite.prepare('SELECT * FROM daily_spend ORDER BY cost_currency').all();
      const beforeRead = rawRows();
      const readHistory = () => readUsageHistoryWith({
        getAllSpendDays,
        getModelUsageSince: async () => [],
        getGatewayModelPricing: async () => null,
        getReferenceModelPricing: () => ({}),
        getModelPriceOverridesSnapshot: () => ({}),
        isModelPricingRefreshInFlight: () => false,
        todayKey: () => localDayKey(),
      });
      const expected = currency === 'CNY' ? 4 * USD_TO_CNY_FIXED_RATE + 10 : 4;
      const today = await getTodaySpend();
      expect(today).toMatchObject({ amount: expected, currency, approximate: false });
      expect(today).toEqual((await readHistory()).totals.today);
      expect(rawRows()).toEqual(beforeRead);

      const receipt = await incrementDailySpend(currency === 'CNY' ? cny(2) : usd(2));
      expect(receipt).toEqual({ day: localDayKey(), money: (await readHistory()).totals.today });
      expect(receipt.money.amount).toBeCloseTo(expected + 2);
      expect(rawRows()).toEqual([
        expect.objectContaining({ cost_currency: 'CNY', cost_amount: currency === 'CNY' ? 12 : 10, cost_usd: 0, cost_is_approximate: 0 }),
        expect.objectContaining({ cost_currency: 'USD', cost_amount: currency === 'USD' ? 6 : 4, cost_usd: 0, cost_is_approximate: 0 }),
      ]);
    } finally {
      harness.close();
    }
  });

  it('returns per-day rows unfolded so the caller collapses after the currency is known', async () => {
    // 回归护栏。折叠是一个依赖账本币种的决定，而账本币种要等报价快照恢复才确定。
    // 若在 getAllSpendDays 内部折叠，冷启动时(usageHistory 与 getModelPricing 并发)
    // 会先按兜底币种把本账号那一行丢掉，调用方再怎么等也拿不回来。
    const harness = createHarness();
    try {
      setActiveLedgerCurrency('CNY');
      await incrementDailySpend(cny(149.13));
      setActiveLedgerCurrency('USD');
      await incrementDailySpend(usd(15.44));

      // 读侧不折叠：两个币种都原样返回，与当前账本币种无关。
      const days = await getAllSpendDays();
      expect(days).toHaveLength(1);
      const monies = [...days[0].monies].sort((a, b) => a.currency.localeCompare(b.currency));
      expect(monies.map((m) => [m.currency, m.amount])).toEqual([
        ['CNY', 149.13],
        ['USD', 15.44],
      ]);

      // 折叠由调用方在币种确定后做，两个方向都能取到自己那一行。
      expect(collapseDayMonies(days[0].monies, 'USD')).toMatchObject({
        amount: 15.44,
        currency: 'USD',
      });
      expect(collapseDayMonies(days[0].monies, 'CNY')).toMatchObject({
        amount: 149.13,
        currency: 'CNY',
      });
    } finally {
      harness.close();
    }
  });

  it('accepts the account settlement currency even when it differs from the build region', async () => {
    // 结算币种由服务端按账号所属租户下发,不是构建区域:CN 构建 + USD 结算账号是正常
    // 组合。按区域判会把这些账号的每一笔都拒收 —— 等于完全不计费。
    const harness = createHarness();
    try {
      setActiveLedgerCurrency('USD');
      await incrementDailySpend(usd(1.5));
      await incrementDailyModelUsage({
        agentKind: 'claude-code',
        model: 'claude-opus-4-8',
        money: usd(2),
        inputTokensDelta: 100,
        outputTokensDelta: 10,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      });

      expect(
        harness.sqlite.prepare('SELECT cost_amount, cost_currency FROM daily_spend').get(),
      ).toEqual({ cost_amount: 1.5, cost_currency: 'USD' });
      expect(
        harness.sqlite
          .prepare('SELECT cost_amount, cost_currency FROM daily_model_usage WHERE day = ?')
          .get(localDayKey()),
      ).toMatchObject({ cost_amount: 2, cost_currency: 'USD' });
    } finally {
      harness.close();
    }
  });

  it('splits model usage rows per currency without dropping tokens', async () => {
    const harness = createHarness();
    try {
      setActiveLedgerCurrency('USD');
      await incrementDailyModelUsage({
        agentKind: 'claude-code',
        model: 'claude-opus-4-8',
        money: usd(2),
        inputTokensDelta: 100,
        outputTokensDelta: 10,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      });
      setActiveLedgerCurrency('CNY');
      await incrementDailyModelUsage({
        agentKind: 'claude-code',
        model: 'claude-opus-4-8',
        money: cny(13.4),
        inputTokensDelta: 50,
        outputTokensDelta: 5,
        cacheReadTokensDelta: 7,
        cacheCreateTokensDelta: 0,
      });

      const rows = harness.sqlite
        .prepare(
          `SELECT cost_currency, cost_amount, input_tokens, output_tokens, cache_read_tokens
           FROM daily_model_usage WHERE day = ? ORDER BY cost_currency`,
        )
        .all(localDayKey()) as Array<Record<string, number | string>>;
      // 金额分行互不覆盖;token 各自留在自己那行,合计仍是 150 / 15 / 7。
      expect(rows).toEqual([
        {
          cost_currency: 'CNY',
          cost_amount: 13.4,
          input_tokens: 50,
          output_tokens: 5,
          cache_read_tokens: 7,
        },
        {
          cost_currency: 'USD',
          cost_amount: 2,
          input_tokens: 100,
          output_tokens: 10,
          cache_read_tokens: 0,
        },
      ]);
    } finally {
      harness.close();
    }
  });
});
