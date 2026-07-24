import { describe, expect, it } from 'vitest';

import { computeScheduleRunCostDeltas } from '../runCostLedger.js';

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
): Record<string, unknown> {
  return {
    origin: { kind: 'scheduler', scheduleId: 'schedule-1', runId },
    turnCost: {
      amount,
      currency: 'CNY',
      approximate: isEstimate,
      kind: isEstimate ? 'value-estimate' : 'actual-cost',
      ...(isEstimate ? { estimateReasons: ['subscription-value'] } : {}),
    },
    turnCostIsEstimate: isEstimate,
  };
}

describe('computeScheduleRunCostDeltas', () => {
  it('旧 USD 真实费用按当前 CN 区域投影后累计到对应 run', () => {
    expect(computeScheduleRunCostDeltas({}, meta('run-1', 0.42))).toEqual([
      {
        runId: 'run-1',
        costAmountDelta: 2.814,
        estimatedValueAmountDelta: 0,
        currency: 'CNY',
        approximate: true,
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
      currency: 'CNY',
      approximate: true,
    });
    expect(delta.costAmountDelta).toBeCloseTo(2.68);
    expect(delta.estimatedValueAmountDelta).toBeCloseTo(-2.814);
  });

  it('归因 runId 修正时从旧 run 扣除并写入新 run', () => {
    expect(computeScheduleRunCostDeltas(meta('run-old', 0.42), meta('run-new', 0.42))).toEqual([
      {
        runId: 'run-old',
        costAmountDelta: -2.814,
        estimatedValueAmountDelta: 0,
        currency: 'CNY',
        approximate: true,
      },
      {
        runId: 'run-new',
        costAmountDelta: 2.814,
        estimatedValueAmountDelta: 0,
        currency: 'CNY',
        approximate: true,
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
        currency: 'CNY',
        approximate: false,
      },
    ]);
  });
});
