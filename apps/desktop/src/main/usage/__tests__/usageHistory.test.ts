import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const currentDbClient = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
}));
const mocks = vi.hoisted(() => ({
  electronAppGetPath: vi.fn(() => ''),
}));

vi.mock('../../localDb/dailySpend', () => ({
  getAllSpendDays: vi.fn(),
  localDayKey: () => '2026-06-11',
}));
vi.mock('../../localDb/dailyModelUsage', () => ({
  getModelUsageSince: vi.fn(),
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: () => currentDbClient.userId,
}));
vi.mock('../modelPricing', () => ({
  getModelPricing: vi.fn(),
  isModelPricingRefreshInFlight: vi.fn(() => false),
  readModelPriceOverridesSnapshot: vi.fn(() => ({})),
  getClaudeSubscriptionValuePrice: (
    model: string,
    pricing: Record<string, Record<string, unknown>> | null | undefined,
    at?: string | Date,
  ) =>
    model === 'claude-sonnet-5'
      ? {
          providerId: 'anthropic',
          modelId: model,
          currency: 'USD',
          source: 'subscription-reference',
          approximate: true,
          inputPerMtok: String(at).slice(0, 10) < '2026-09-01' ? 2 : 3,
          outputPerMtok: String(at).slice(0, 10) < '2026-09-01' ? 10 : 15,
        }
      : pricing?.anthropic?.[model],
  getCodexSubscriptionValuePrice: (
    model: string,
    pricing: Record<string, Record<string, unknown>> | null | undefined,
  ) =>
    pricing?.openai?.[model] ??
    (model === 'gpt-5.5'
      ? {
          providerId: 'openai',
          modelId: model,
          currency: 'USD',
          source: 'subscription-reference',
          approximate: true,
          inputPerMtok: 2,
          outputPerMtok: 8,
        }
      : undefined),
  getCodexProviderSubscriptionValuePrice: (
    providerId: string,
    model: string,
  ) =>
    providerId === 'anthropic' && model === 'claude-sonnet-5'
      ? {
          providerId: 'anthropic',
          modelId: model,
          currency: 'USD',
          source: 'subscription-reference',
          approximate: true,
          inputPerMtok: 2,
          outputPerMtok: 10,
        }
      : undefined,
  getSubscriptionDirectValuePrice: (model: string) =>
    model === 'xai/grok-4.3'
      ? {
          providerId: 'xai',
          modelId: model,
          currency: 'USD',
          source: 'subscription-reference',
          approximate: true,
          inputPerMtok: 3,
          outputPerMtok: 15,
        }
      : undefined,
}));
vi.mock('electron', () => ({
  app: {
    getPath: mocks.electronAppGetPath,
  },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  __resetUsageHistoryCacheForTesting,
  claudeSubscriptionUsageModelKey,
  codexApiUsageModelKey,
  codexSubscriptionUsageModelKey,
  computeAnomaly,
  computeStreaks,
  emptyUsageHistoryPayload,
  piSubscriptionUsageModelKey,
  prevDayKey,
  readUsageHistory,
  readUsageHistoryWith,
  shiftDayKey,
  type UsageHistoryDeps,
} from '../usageHistory';
import { getAllSpendDays } from '../../localDb/dailySpend';
import { getModelUsageSince } from '../../localDb/dailyModelUsage';
import { getModelPricing, isModelPricingRefreshInFlight } from '../modelPricing';
import {
  __resetActiveLedgerCurrencyForTesting,
  setActiveLedgerCurrency,
} from '../ledgerCurrency';
import {
  DEFAULT_USAGE_CURRENCY,
  USD_TO_CNY_FIXED_RATE,
  zeroUsageMoney,
  type ModelPriceQuote,
  type RegionalMoney,
} from '../../../shared/regionalMoney';

const TODAY = '2026-06-11';

function actual(amount: number, approximate = false): RegionalMoney {
  return {
    amount,
    currency: DEFAULT_USAGE_CURRENCY,
    approximate,
    kind: 'actual-cost',
    ...(approximate ? { estimateReasons: ['legacy-usd'] } : {}),
  };
}

function regionalUsdAmount(amount: number): number {
  return DEFAULT_USAGE_CURRENCY === 'CNY'
    ? amount * USD_TO_CNY_FIXED_RATE
    : amount;
}

function subscriptionQuote(
  providerId: string,
  modelId: string,
  inputPerMtok: number,
  outputPerMtok: number,
): ModelPriceQuote {
  return {
    providerId,
    modelId,
    currency: 'USD',
    source: 'subscription-reference',
    approximate: true,
    inputPerMtok,
    outputPerMtok,
  };
}

function modelRow(
  day: string,
  agentKind: 'claude-code' | 'codex' | 'pi',
  model: string,
  money: RegionalMoney,
  tokens: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
  } = {},
) {
  return {
    day,
    agentKind,
    model,
    money,
    inputTokens: tokens.inputTokens ?? 0,
    outputTokens: tokens.outputTokens ?? 0,
    cacheReadTokens: tokens.cacheReadTokens ?? 0,
    cacheCreateTokens: tokens.cacheCreateTokens ?? 0,
  };
}

function makeDeps(overrides: Partial<UsageHistoryDeps> = {}): UsageHistoryDeps {
  return {
    getAllSpendDays: async () => [],
    getModelUsageSince: async () => [],
    getModelPricing: async () => null,
    getModelPriceOverridesSnapshot: () => ({}),
    isModelPricingRefreshInFlight: () => false,
    todayKey: () => TODAY,
    ...overrides,
  };
}

beforeEach(async () => {
  mocks.electronAppGetPath.mockReturnValue(
    await mkdtemp(path.join(os.tmpdir(), 'cindy-usage-history-')),
  );
  currentDbClient.userId = 'user-a';
  __resetUsageHistoryCacheForTesting();
  // 账本币种是跨用例的模块级状态,逐例重置回未知,让默认路径的用例始终从
  // 构建默认币种起算,不受前一例显式设定的账号币种影响。
  __resetActiveLedgerCurrencyForTesting();
  vi.mocked(getAllSpendDays).mockResolvedValue([]);
  vi.mocked(getModelUsageSince).mockResolvedValue([]);
  vi.mocked(getModelPricing).mockResolvedValue(null);
  vi.mocked(isModelPricingRefreshInFlight).mockReturnValue(false);
});

afterEach(async () => {
  const dir = mocks.electronAppGetPath();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (dir) {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe('day arithmetic and streaks', () => {
  it('crosses month/year boundaries and shifts arbitrary deltas', () => {
    expect(prevDayKey('2026-01-01')).toBe('2025-12-31');
    expect(prevDayKey('2026-03-01')).toBe('2026-02-28');
    expect(shiftDayKey('2026-06-11', -30)).toBe('2026-05-12');
  });

  it('keeps today grace while preserving the longest historical run', () => {
    expect(computeStreaks(
      ['2026-05-01', '2026-05-02', '2026-05-03', '2026-06-09', '2026-06-10'],
      TODAY,
    )).toEqual({ current: 2, longest: 3 });
    expect(computeStreaks([], TODAY)).toEqual({ current: 0, longest: 0 });
  });
});

describe('anomaly detection', () => {
  function spendMap(trailing: number[], todayValue: number): Map<string, number> {
    const values = new Map<string, number>();
    trailing.forEach((value, index) => {
      values.set(shiftDayKey(TODAY, -(index + 1)), value);
    });
    values.set(TODAY, todayValue);
    return values;
  }

  it('requires three active baseline days and a strict two-times increase', () => {
    expect(computeAnomaly(
      spendMap([5, 0, 0, 0, 0, 0, 0], 100),
      TODAY,
    )).toEqual({ isAnomalous: false, trailing7DayAvg: null });
    expect(computeAnomaly(
      spendMap([7, 7, 7, 0, 0, 0, 0], 7),
      TODAY,
    )).toEqual({ isAnomalous: true, trailing7DayAvg: 3 });
    expect(computeAnomaly(
      spendMap([7, 7, 7, 7, 7, 7, 7], 14),
      TODAY,
    )).toEqual({ isAnomalous: false, trailing7DayAvg: 7 });
  });
});

describe('billing model keys', () => {
  it('keeps API and subscription accounting rows distinct', () => {
    expect(codexApiUsageModelKey('gpt-5.5')).toBe('gpt-5.5#billing=api');
    expect(codexSubscriptionUsageModelKey('gpt-5.5')).toBe(
      'gpt-5.5#billing=subscription',
    );
    expect(claudeSubscriptionUsageModelKey('claude-opus-4-8')).toBe(
      'claude-opus-4-8#billing=subscription',
    );
    expect(piSubscriptionUsageModelKey('chatgpt/gpt-5.6-sol')).toBe(
      'chatgpt/gpt-5.6-sol#billing=subscription',
    );
  });
});

describe('readUsageHistoryWith', () => {
  it('aggregates actual money and subscription value without double counting', async () => {
    const estimateAmount = regionalUsdAmount(2);
    const result = await readUsageHistoryWith(makeDeps({
      getAllSpendDays: async () => [
        { day: '2026-06-10', monies: [actual(3)] },
        { day: TODAY, monies: [actual(5)] },
      ],
      getModelUsageSince: async () => [
        modelRow(
          '2026-06-10',
          'claude-code',
          'claude-opus-4-8',
          actual(2),
          { inputTokens: 10, outputTokens: 20 },
        ),
        modelRow(
          TODAY,
          'claude-code',
          'claude-opus-4-8',
          actual(4),
          { inputTokens: 10, outputTokens: 20 },
        ),
        modelRow(
          TODAY,
          'codex',
          codexSubscriptionUsageModelKey('gpt-5.5'),
          actual(0),
          { inputTokens: 1_000_000 },
        ),
        modelRow(
          TODAY,
          'codex',
          codexApiUsageModelKey('gpt-5.5'),
          actual(1),
          { outputTokens: 100 },
        ),
      ],
      getModelPricing: async () => ({
        openai: {
          'gpt-5.5': subscriptionQuote('openai', 'gpt-5.5', 2, 8),
        },
      }),
    }));

    expect(result.estimatesPending).toBe(false);
    expect(result.totals.today).toEqual(actual(5));
    expect(result.totals.last30Days).toEqual(actual(8));
    expect(result.totals.last30DaysEstimatedValue).toMatchObject({
      amount: estimateAmount,
      kind: 'value-estimate',
      approximate: true,
    });
    expect(result.totals.last30DaysWithEstimatedValue.amount).toBeCloseTo(
      8 + estimateAmount,
    );
    expect(result.totals.last30DaysWithEstimatedValue.approximate).toBe(true);
    expect(result.totals.todayTokens).toBe(1_000_130);
    expect(result.totals.last30DaysTokens).toBe(1_000_160);

    const subscription = result.models.find(
      (row) => row.agentKind === 'codex' && row.estimatedMoney,
    );
    expect(subscription?.estimatedMoney?.amount).toBeCloseTo(estimateAmount);
    const api = result.modelDaily.find(
      (row) => row.apiMoney.amount === 1,
    );
    expect(api?.subscriptionEstimateMoney.amount).toBe(0);
  });

  it('resolves subscription reference prices for each usage day', async () => {
    const result = await readUsageHistoryWith(
      makeDeps({
        todayKey: () => '2026-09-02',
        getModelUsageSince: async () => [
          modelRow(
            '2026-08-31',
            'claude-code',
            claudeSubscriptionUsageModelKey('claude-sonnet-5'),
            actual(0),
            { inputTokens: 1_000_000 },
          ),
          modelRow(
            '2026-09-01',
            'claude-code',
            claudeSubscriptionUsageModelKey('claude-sonnet-5'),
            actual(0),
            { inputTokens: 1_000_000 },
          ),
        ],
      }),
    );

    expect(result.modelDaily.map((row) => row.subscriptionEstimateMoney.amount)).toEqual([
      regionalUsdAmount(2),
      regionalUsdAmount(3),
    ]);
    expect(result.models[0].estimatedMoney?.amount).toBeCloseTo(regionalUsdAmount(5));
    expect(result.totals.last30DaysEstimatedValue.amount).toBeCloseTo(regionalUsdAmount(5));
  });

  it('keeps current-region subscription estimates when history uses another currency', async () => {
    const historicalCurrency = DEFAULT_USAGE_CURRENCY === 'CNY' ? 'USD' : 'CNY';
    const estimateAmount = regionalUsdAmount(2);
    const result = await readUsageHistoryWith(
      makeDeps({
        getAllSpendDays: async () => [
          {
            day: TODAY,
            monies: [{
              amount: 5,
              currency: historicalCurrency,
              approximate: false,
              kind: 'actual-cost',
            }],
          },
        ],
        getModelUsageSince: async () => [
          modelRow(TODAY, 'codex', codexSubscriptionUsageModelKey('gpt-5.5'), actual(0), {
            inputTokens: 1_000_000,
          }),
          modelRow(
            TODAY,
            'claude-code',
            'legacy-mixed-currency',
            {
              amount: 10,
              currency: historicalCurrency,
              approximate: false,
              kind: 'actual-cost',
            },
            { outputTokens: 20 },
          ),
        ],
        getModelPricing: async () => ({
          openai: {
            'gpt-5.5': subscriptionQuote('openai', 'gpt-5.5', 2, 8),
          },
        }),
      }),
    );

    expect(result.totals.today).toEqual(actual(0));
    expect(result.totals.last30Days).toEqual(actual(0));
    expect(result.totals.last30DaysEstimatedValue).toMatchObject({
      amount: estimateAmount,
      currency: DEFAULT_USAGE_CURRENCY,
    });
    expect(result.totals.last30DaysWithEstimatedValue.amount).toBeCloseTo(estimateAmount);
    expect(result.days[0]).toMatchObject({
      money: actual(0),
      tokens: 1_000_020,
    });
    expect(
      result.models.find((row) => row.model === 'legacy-mixed-currency'),
    ).toMatchObject({
      money: actual(0),
      estimatedMoney: null,
      outputTokens: 20,
    });
    expect(
      result.modelDaily.find((row) => row.model === 'legacy-mixed-currency'),
    ).toMatchObject({
      money: {
        amount: 0,
        currency: DEFAULT_USAGE_CURRENCY,
      },
      apiMoney: actual(0),
      tokens: 20,
    });
  });

  it('keeps a USD-settled account history intact regardless of build region', async () => {
    // 结算币种由服务端按账号所属租户下发,不是构建区域。账本币种若按区域取,
    // 以 USD 结算的账号在 CN 构建上每一行都会被判成异币种归零 —— 等于这些用户不计费。
    //
    // 账号币种必须在这里显式落一次:本文件把 modelPricing 整体 mock 掉了,而生产里
    // 正是它(replaceGatewayModelPricing / 磁盘快照恢复)把报价币种写进账本币种。
    // 不落这一笔,断言就退化成"构建默认币种恰好是 USD",在 CN 构建上必然红,
    // 反而验不到本例声称的"与构建区域无关"。
    setActiveLedgerCurrency('USD');
    const usdRow = (amount: number): RegionalMoney => ({
      amount,
      currency: 'USD',
      approximate: false,
      kind: 'actual-cost',
    });
    const result = await readUsageHistoryWith(
      makeDeps({
        getAllSpendDays: async () => [
          { day: '2026-06-10', monies: [usdRow(3)] },
          { day: TODAY, monies: [usdRow(5)] },
        ],
        getModelUsageSince: async () => [],
        getModelPricing: async () => ({
          xd: {
            'gpt-5.5': {
              providerId: 'xd',
              modelId: 'gpt-5.5',
              currency: 'USD',
              source: 'gateway',
              approximate: false,
              inputPerMtok: 3,
              outputPerMtok: 15,
            },
          },
        }),
      }),
    );

    expect(result.totals.today).toMatchObject({ amount: 5, currency: 'USD' });
    expect(result.totals.last30Days).toMatchObject({ amount: 8, currency: 'USD' });
  });

  it('uses provider-scoped Anthropic reference pricing for Claude subscription rows', async () => {
    const expected = regionalUsdAmount(5);
    const result = await readUsageHistoryWith(makeDeps({
      getModelUsageSince: async () => [
        modelRow(
          TODAY,
          'claude-code',
          claudeSubscriptionUsageModelKey('claude-opus-4-8'),
          actual(0),
          { inputTokens: 1_000_000 },
        ),
      ],
      getModelPricing: async () => ({
        anthropic: {
          'claude-opus-4-8': subscriptionQuote(
            'anthropic',
            'claude-opus-4-8',
            5,
            25,
          ),
        },
      }),
    }));

    expect(result.models[0]).toMatchObject({
      agentKind: 'claude-code',
      model: 'claude-opus-4-8',
    });
    expect(result.models[0].estimatedMoney?.amount).toBe(expected);
  });

  it('keeps Pi cache usage as a distinct subscription row', async () => {
    const result = await readUsageHistoryWith(makeDeps({
      getModelUsageSince: async () => [
        modelRow(
          TODAY,
          'pi',
          piSubscriptionUsageModelKey('gpt-5.5'),
          actual(0),
          { inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 900_000 },
        ),
      ],
    }));

    expect(result.models[0]).toMatchObject({
      agentKind: 'pi',
      model: 'gpt-5.5',
      inputTokens: 100_000,
      cacheReadTokens: 900_000,
    });
    expect(result.models[0].estimatedMoney?.amount).toBeGreaterThan(0);
    expect(result.totals.todayTokens).toBe(1_002_000);
  });

  it('marks estimates pending only when a subscription price is missing during refresh', async () => {
    const row = modelRow(
      TODAY,
      'codex',
      codexSubscriptionUsageModelKey('unknown-model'),
      actual(0),
      { inputTokens: 1_000 },
    );
    const pending = await readUsageHistoryWith(makeDeps({
      getModelUsageSince: async () => [row],
      isModelPricingRefreshInFlight: () => true,
    }));
    const settled = await readUsageHistoryWith(makeDeps({
      getModelUsageSince: async () => [row],
      isModelPricingRefreshInFlight: () => false,
    }));
    expect(pending.estimatesPending).toBe(true);
    expect(settled.estimatesPending).toBe(false);
    expect(settled.models[0].estimatedMoney).toBeNull();
  });

  it('propagates approximate legacy history into anomaly and totals', async () => {
    const trailing = Array.from({ length: 7 }, (_, index) => ({
      day: shiftDayKey(TODAY, -(index + 1)),
      monies: [actual(1, true)],
    }));
    const result = await readUsageHistoryWith(makeDeps({
      getAllSpendDays: async () => [
        ...trailing,
        { day: TODAY, monies: [actual(7, true)] },
      ],
    }));
    expect(result.anomaly).toMatchObject({
      isAnomalous: true,
      trailing7DayAvg: {
        amount: 1,
        approximate: true,
      },
    });
    expect(result.totals.last30Days.approximate).toBe(true);
  });
});

describe('production cache and empty payload', () => {
  it('writes a structured fresh payload and serves it from memory', async () => {
    vi.mocked(getAllSpendDays).mockResolvedValue([
      { day: TODAY, monies: [actual(2)] },
    ]);
    const first = await readUsageHistory({ days: 30 });
    const second = await readUsageHistory({ days: 30 });
    expect(first.stale).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.totals.today).toEqual(actual(2));

    await vi.waitFor(async () => {
      const raw = JSON.parse(
        await readFile(
          path.join(mocks.electronAppGetPath(), 'cache', 'usage-history.json'),
          'utf8',
        ),
      );
      expect(raw).toMatchObject({
        // 日账改为按币种分行、折叠推迟到读侧之后升到 5:v4 快照是用「按区域猜出来的
        // 账本币种」折叠出来的聚合值，不能沿用。改折叠口径时同步这里。
        version: 5,
        optsKey: 'user=user-a|days=30',
        payload: {
          totals: {
            today: actual(2),
          },
        },
      });
    });
  });

  it('returns structured USD zero money on fallback', () => {
    const empty = emptyUsageHistoryPayload();
    expect(empty.totals.today).toEqual(zeroUsageMoney());
    expect(empty.totals.last30DaysEstimatedValue).toEqual(
      zeroUsageMoney('value-estimate'),
    );
  });
});
