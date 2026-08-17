import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));

import type { DbClient } from '../../localDb/client/DbClient';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import { computeScheduleRunCostDeltas, recordScheduleRunCostDirect } from '../runCostLedger.js';

function meta(runId: string, costUsd: number, isEstimate = false): Record<string, unknown> {
  return {
    origin: { kind: 'scheduler', scheduleId: 'schedule-1', runId },
    turnCostUsd: costUsd,
    turnCostIsEstimate: isEstimate,
  };
}

function structuredMeta(
  runId: string,
  amount: number,
  isEstimate = false,
  estimateReason: 'subscription-value' | 'reference-price' | 'sdk-estimate' =
    'subscription-value',
): Record<string, unknown> {
  return {
    origin: { kind: 'scheduler', scheduleId: 'schedule-1', runId },
    turnCost: {
      amount,
      currency: 'CNY',
      approximate: isEstimate,
      kind: isEstimate ? 'value-estimate' : 'actual-cost',
      ...(isEstimate ? { estimateReasons: [estimateReason] } : {}),
    },
    turnCostIsEstimate: isEstimate,
  };
}

function mixedEstimateMeta(runId: string): Record<string, unknown> {
  return {
    origin: { kind: 'scheduler', scheduleId: 'schedule-1', runId },
    turnCost: {
      amount: 0.61,
      currency: 'CNY',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['reference-price', 'sdk-estimate'],
    },
    turnCostIsEstimate: true,
    turnCostIsCustomProvider: true,
    turnUsageDetails: {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      perModelCost: [
        {
          model: 'reference-model',
          money: {
            amount: 0.19,
            currency: 'CNY',
            approximate: true,
            kind: 'value-estimate',
            estimateReasons: ['reference-price'],
          },
        },
        {
          model: 'sdk-model',
          money: {
            amount: 0.42,
            currency: 'CNY',
            approximate: true,
            kind: 'value-estimate',
            estimateReasons: ['sdk-estimate'],
          },
        },
      ],
    },
  };
}

describe('computeScheduleRunCostDeltas', () => {
  it('旧 USD 真实费用保持 USD 原值累计到对应 run', () => {
    expect(computeScheduleRunCostDeltas({}, meta('run-1', 0.42))).toEqual([
      {
        runId: 'run-1',
        costAmountDelta: 0.42,
        estimatedValueAmountDelta: 0,
        sdkEstimatedValueAmountDelta: 0,
        currency: 'USD',
        approximate: false,
      },
    ]);
  });

  it('相同消息重放时不重复累计', () => {
    const current = meta('run-1', 0.42);
    expect(computeScheduleRunCostDeltas(current, { ...current })).toEqual([]);
  });

  it('估算值转为真实费用时在两栏之间搬移', () => {
    const [delta] = computeScheduleRunCostDeltas(meta('run-1', 0.42, true), meta('run-1', 0.4));
    expect(delta).toMatchObject({
      runId: 'run-1',
      currency: 'USD',
      approximate: false,
    });
    expect(delta.costAmountDelta).toBeCloseTo(0.4);
    expect(delta.estimatedValueAmountDelta).toBeCloseTo(-0.42);
    expect(delta.sdkEstimatedValueAmountDelta).toBe(0);
  });

  it('归因 runId 修正时从旧 run 扣除并写入新 run', () => {
    expect(computeScheduleRunCostDeltas(meta('run-old', 0.42), meta('run-new', 0.42))).toEqual([
      {
        runId: 'run-old',
        costAmountDelta: -0.42,
        estimatedValueAmountDelta: 0,
        sdkEstimatedValueAmountDelta: 0,
        currency: 'USD',
        approximate: false,
      },
      {
        runId: 'run-new',
        costAmountDelta: 0.42,
        estimatedValueAmountDelta: 0,
        sdkEstimatedValueAmountDelta: 0,
        currency: 'USD',
        approximate: false,
      },
    ]);
  });

  it('结构化 CN 金额原样累计，订阅估值不污染真实费用约值标记', () => {
    expect(
      computeScheduleRunCostDeltas(
        structuredMeta('run-1', 0.29, true),
        structuredMeta('run-1', 0.42),
      ),
    ).toEqual([
      {
        runId: 'run-1',
        costAmountDelta: 0.42,
        estimatedValueAmountDelta: -0.29,
        sdkEstimatedValueAmountDelta: 0,
        currency: 'CNY',
        approximate: false,
      },
    ]);
  });

  it('单独记录 SDK 估算子项，reference 估算不进入 SDK 子账本', () => {
    expect(
      computeScheduleRunCostDeltas(
        structuredMeta('run-1', 0.19, true, 'reference-price'),
        structuredMeta('run-1', 0.42, true, 'sdk-estimate'),
      ),
    ).toEqual([
      {
        runId: 'run-1',
        costAmountDelta: 0,
        estimatedValueAmountDelta: expect.closeTo(0.23, 10),
        sdkEstimatedValueAmountDelta: 0.42,
        currency: 'CNY',
        approximate: false,
      },
    ]);
  });
  it('mixed reference and SDK estimates only add the SDK portion to the sub-ledger', () => {
    expect(computeScheduleRunCostDeltas({}, mixedEstimateMeta('run-mixed'))).toEqual([
      {
        runId: 'run-mixed',
        costAmountDelta: 0,
        estimatedValueAmountDelta: 0.61,
        sdkEstimatedValueAmountDelta: expect.closeTo(0.42, 10),
        currency: 'CNY',
        approximate: false,
      },
    ]);
  });

  it('reclassifies historical custom-provider actual cost as an SDK estimate', () => {
    expect(
      computeScheduleRunCostDeltas({}, {
        ...structuredMeta('run-historical-custom', 0.42),
        turnCostIsCustomProvider: true,
      }),
    ).toEqual([
      {
        runId: 'run-historical-custom',
        costAmountDelta: 0,
        estimatedValueAmountDelta: 0.42,
        sdkEstimatedValueAmountDelta: 0.42,
        currency: 'CNY',
        approximate: false,
      },
    ]);
  });
});

describe('recordScheduleRunCostDirect', () => {
  it('忽略低于消息账本阈值的正费用', async () => {
    await expect(recordScheduleRunCostDirect({
      runId: 'run-near-zero',
      money: {
        amount: 1e-12,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
    })).resolves.toBeNull();
  });

  it('更新竞态下 run 已消失时返回 null', async () => {
    const selectChain = {
      from() {
        return this;
      },
      where() {
        return this;
      },
      async limit() {
        return [{ scheduleId: 'schedule-1' }];
      },
    };
    const updateChain = {
      set() {
        return this;
      },
      where() {
        return this;
      },
      async run() {
        return { changes: 0 };
      },
    };
    const dbClient = {
      drizzle: {
        select: () => selectChain,
        update: () => updateChain,
      },
    } as unknown as DbClient;
    setCurrentDbClient(dbClient, 'test-user');
    try {
      await expect(recordScheduleRunCostDirect({
        runId: 'run-raced-delete',
        money: {
          amount: 0.42,
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      })).resolves.toBeNull();
    } finally {
      clearCurrentDbClient(dbClient);
    }
  });
});
