import { describe, expect, it } from 'vitest';

import type { UsageHistoryPayload } from '@/hooks/useUsageHistory';
import {
  buildAgentRows,
  buildModelRows,
  buildSummary,
  cacheHitRate,
  computeTokenStreak,
  isUsageHistoryEmpty,
  toUsageDays,
} from '../usageHistoryStats';

const zeroMoney = {
  amount: 0,
  currency: 'USD' as const,
  approximate: false,
  kind: 'actual-cost' as const,
};

function model(over: Partial<UsageHistoryPayload['models'][number]>) {
  return {
    agentKind: 'claude-code' as const,
    model: 'claude-opus-4-8',
    money: zeroMoney,
    estimatedMoney: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    ...over,
  };
}

function payload(over: Partial<UsageHistoryPayload> = {}): UsageHistoryPayload {
  return {
    generatedAt: 0,
    todayKey: '2026-08-22',
    days: [],
    modelDaily: [],
    models: [],
    streak: { current: 0, longest: 0 },
    totals: {
      today: zeroMoney,
      last30Days: zeroMoney,
      last30DaysWithEstimatedValue: zeroMoney,
      last30DaysEstimatedValue: zeroMoney,
      todayTokens: 0,
      last30DaysTokens: 0,
    },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
    ...over,
  };
}

describe('cacheHitRate', () => {
  it('输出 token 不进分母 (与逐轮卡片同一公式)', () => {
    expect(
      cacheHitRate({ inputTokens: 100, cacheReadTokens: 300, cacheCreateTokens: 100 }),
    ).toBeCloseTo(0.6);
  });

  it('分母为 0 时返回 null 而不是 0 —— 没有上下文可复用与命中率为零是两回事', () => {
    expect(
      cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }),
    ).toBeNull();
  });
});

describe('computeTokenStreak', () => {
  const days = (...keys: string[]) => keys.map((day) => ({ day, tokens: 1000 }));

  it('今日有记录时从今日起算', () => {
    const streak = computeTokenStreak(
      days('2026-08-20', '2026-08-21', '2026-08-22'),
      '2026-08-22',
    );
    expect(streak.current).toBe(3);
  });

  it('今日还没跑过时从昨天起算, 不把昨天的连续清零', () => {
    const streak = computeTokenStreak(days('2026-08-20', '2026-08-21'), '2026-08-22');
    expect(streak.current).toBe(2);
  });

  it('昨天与今天都没有记录时 current 归零, longest 仍保留历史最长', () => {
    const streak = computeTokenStreak(
      days('2026-08-01', '2026-08-02', '2026-08-03', '2026-08-10'),
      '2026-08-22',
    );
    expect(streak.current).toBe(0);
    expect(streak.longest).toBe(3);
  });

  it('跨月连续不断档', () => {
    const streak = computeTokenStreak(
      days('2026-07-30', '2026-07-31', '2026-08-01'),
      '2026-08-01',
    );
    expect(streak).toEqual({ current: 3, longest: 3 });
  });

  it('无任何活跃日时返回 0/0', () => {
    expect(computeTokenStreak([], '2026-08-22')).toEqual({ current: 0, longest: 0 });
  });
});

describe('toUsageDays', () => {
  it('丢掉没有 token 的日子 (只有金额没有 token 的历史日不算活跃)', () => {
    const rows = toUsageDays(
      payload({
        days: [
          { day: '2026-08-21', money: zeroMoney, tokens: 0 },
          { day: '2026-08-22', money: zeroMoney, tokens: 500 },
        ],
      }),
    );
    expect(rows).toEqual([{ day: '2026-08-22', tokens: 500 }]);
  });

  it('旧快照缺 tokens 字段时按 0 兜底, 不会 NaN', () => {
    const rows = toUsageDays(
      payload({ days: [{ day: '2026-08-22', money: zeroMoney }] }),
    );
    expect(rows).toEqual([]);
  });
});

describe('buildModelRows', () => {
  it('按 token 降序并给出占比', () => {
    const rows = buildModelRows(
      payload({
        models: [
          model({ model: 'haiku', inputTokens: 100 }),
          model({ model: 'opus', inputTokens: 900 }),
        ],
      }),
    );
    expect(rows.map((r) => r.model)).toEqual(['opus', 'haiku']);
    expect(rows[0].share).toBeCloseTo(0.9);
  });

  it('同一模型的 api / subscription 两个计费维度合并成一行', () => {
    // main 侧按带 #billing= 后缀的原始 model 聚合, 到 payload 时后缀已被剥掉 ——
    // 不合并会渲染出两行同名模型 + 重复 React key, 并让模型数多算。
    const rows = buildModelRows(
      payload({
        models: [
          model({ model: 'claude-opus-4-8', inputTokens: 100, cacheReadTokens: 300 }),
          model({ model: 'claude-opus-4-8', inputTokens: 50, outputTokens: 20 }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toBe(470);
    expect(rows[0].inputTokens).toBe(150);
    expect(rows[0].share).toBe(1);
    // 命中率按合并后的分子分母算: 300 / (150 + 300 + 0)
    expect(rows[0].cacheHitRate).toBeCloseTo(300 / 450);
  });

  it('同名模型跨 agent 分成两行 (网关模型 id 可能撞名)', () => {
    const rows = buildModelRows(
      payload({
        models: [
          model({ agentKind: 'claude-code', model: 'gpt-5.5', inputTokens: 10 }),
          model({ agentKind: 'codex', model: 'gpt-5.5', inputTokens: 20 }),
        ],
      }),
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe('buildAgentRows', () => {
  const sample = payload({
    todayKey: '2026-08-22',
    models: [
      model({ agentKind: 'claude-code', model: 'opus', inputTokens: 100, cacheReadTokens: 900 }),
      model({ agentKind: 'claude-code', model: 'haiku', inputTokens: 100, cacheReadTokens: 100 }),
      model({ agentKind: 'codex', model: 'gpt-5.5', inputTokens: 800, cacheReadTokens: 200 }),
    ],
    modelDaily: [
      {
        day: '2026-08-22',
        agentKind: 'claude-code',
        model: 'opus',
        money: zeroMoney,
        apiMoney: zeroMoney,
        subscriptionEstimateMoney: zeroMoney,
        tokens: 320,
      },
      {
        day: '2026-08-21',
        agentKind: 'codex',
        model: 'gpt-5.5',
        money: zeroMoney,
        apiMoney: zeroMoney,
        subscriptionEstimateMoney: zeroMoney,
        tokens: 999,
      },
    ],
  });

  it('modelCount 不把同一模型的两个计费维度数成两个', () => {
    const rows = buildAgentRows(
      payload({
        models: [
          model({ agentKind: 'codex', model: 'gpt-5.5', inputTokens: 100 }),
          model({ agentKind: 'codex', model: 'gpt-5.5', inputTokens: 200 }),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].modelCount).toBe(1);
    expect(rows[0].tokens).toBe(300);
  });

  it('按 agent 合并模型并数出模型个数', () => {
    const rows = buildAgentRows(sample);
    const claude = rows.find((r) => r.agentKind === 'claude-code');
    expect(claude?.modelCount).toBe(2);
    expect(claude?.tokens).toBe(1200);
  });

  it('命中率分子分母各自加总, 不是对各模型命中率取平均', () => {
    const claude = buildAgentRows(sample).find((r) => r.agentKind === 'claude-code');
    // (900 + 100) / (200 + 1000) = 0.8333…；按模型平均会得到 (0.9 + 0.5) / 2 = 0.7
    expect(claude?.cacheHitRate).toBeCloseTo(1000 / 1200);
  });

  it('today 只统计 todayKey 当天的行', () => {
    const rows = buildAgentRows(sample);
    expect(rows.find((r) => r.agentKind === 'claude-code')?.todayTokens).toBe(320);
    expect(rows.find((r) => r.agentKind === 'codex')?.todayTokens).toBe(0);
  });
});

describe('buildSummary / isUsageHistoryEmpty', () => {
  it('token 总量直接取 payload.totals', () => {
    const summary = buildSummary(
      payload({
        totals: {
          today: zeroMoney,
          last30Days: zeroMoney,
          last30DaysWithEstimatedValue: zeroMoney,
          last30DaysEstimatedValue: zeroMoney,
          todayTokens: 1234,
          last30DaysTokens: 56789,
        },
      }),
    );
    expect(summary.todayTokens).toBe(1234);
    expect(summary.last30DaysTokens).toBe(56789);
  });

  it('payload 为 null 时给出全零快照而不是抛错', () => {
    expect(buildSummary(null)).toEqual({
      todayTokens: 0,
      last30DaysTokens: 0,
      streak: { current: 0, longest: 0 },
      cacheHitRate: null,
      modelCount: 0,
    });
    expect(isUsageHistoryEmpty(null)).toBe(true);
  });

  it('有 token 记录时不算空', () => {
    expect(
      isUsageHistoryEmpty(payload({ models: [model({ inputTokens: 10 })] })),
    ).toBe(false);
  });
});
