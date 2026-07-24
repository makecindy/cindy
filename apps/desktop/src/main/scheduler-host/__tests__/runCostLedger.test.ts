import { describe, expect, it } from 'vitest';

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

describe('computeScheduleRunCostDeltas', () => {
  it('首次写入真实费用时累计到对应 run', () => {
    expect(computeScheduleRunCostDeltas({}, meta('run-1', 0.42))).toEqual([{
      runId: 'run-1',
      costUsdDelta: 0.42,
      estimatedValueUsdDelta: 0,
    }]);
  });

  it('相同消息重放时不重复累计', () => {
    const current = meta('run-1', 0.42);
    expect(computeScheduleRunCostDeltas(current, { ...current })).toEqual([]);
  });

  it('估算值转为真实费用时在两栏之间搬移', () => {
    expect(computeScheduleRunCostDeltas(meta('run-1', 0.42, true), meta('run-1', 0.4))).toEqual([{
      runId: 'run-1',
      costUsdDelta: 0.4,
      estimatedValueUsdDelta: -0.42,
    }]);
  });

  it('归因 runId 修正时从旧 run 扣除并写入新 run', () => {
    expect(computeScheduleRunCostDeltas(meta('run-old', 0.42), meta('run-new', 0.42))).toEqual([
      { runId: 'run-old', costUsdDelta: -0.42, estimatedValueUsdDelta: 0 },
      { runId: 'run-new', costUsdDelta: 0.42, estimatedValueUsdDelta: 0 },
    ]);
  });
});

describe('recordScheduleRunCostDirect', () => {
  it('忽略低于消息账本阈值的正费用', async () => {
    await expect(recordScheduleRunCostDirect({
      runId: 'run-near-zero',
      costUsd: 1e-12,
      isEstimate: false,
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
        costUsd: 0.42,
        isEstimate: false,
      })).resolves.toBeNull();
    } finally {
      clearCurrentDbClient(dbClient);
    }
  });
});
