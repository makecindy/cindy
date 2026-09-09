import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import type { UsageHistoryPayload } from '@/hooks/useUsageHistory';
import {
  buildAgentRows,
  buildModelRows,
  buildSummary,
  cacheHitRate,
  chartUsageHistoryPayload,
  computeTokenStreak,
  filterUsageHistoryPayload,
  isUsageHistorySingleDay,
  isUsageHistoryEmpty,
  usageRangeDay,
  toUsageDays,
} from '../usageHistoryStats';
import {
  removeUsageSessionForScope,
  mergeUsageSessionSnapshots,
  shouldHideUsageTaskTable,
  usageActivityIso,
  usageSessionsForScope,
  type UsageSessionsState,
} from '../UsageTaskTable';

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

describe('shouldHideUsageTaskTable', () => {
  it('单日范围（包括 today）隐藏无法精确归因的任务表', () => {
    expect(shouldHideUsageTaskTable('today')).toBe(true);
    expect(shouldHideUsageTaskTable('day:2026-08-20')).toBe(true);
    expect(shouldHideUsageTaskTable('7d')).toBe(false);
  });
});

describe('isUsageHistorySingleDay', () => {
  it('识别 today 与日期钻取范围', () => {
    expect(isUsageHistorySingleDay('today')).toBe(true);
    expect(isUsageHistorySingleDay('day:2026-08-20')).toBe(true);
    expect(isUsageHistorySingleDay('7d')).toBe(false);
  });
});

describe('usageRangeDay', () => {
  it('Today 使用 payload 的日期锚点，和图表点击当天保持同一 selectedDay', () => {
    expect(usageRangeDay('today', '2026-08-22')).toBe('2026-08-22');
    expect(usageRangeDay('today')).toBeNull();
    expect(usageRangeDay('day:2026-08-20', '2026-08-22')).toBe('2026-08-20');
  });
});

describe('usage task session scope', () => {
  const readyState = (scopeKey: string): UsageSessionsState => ({
    scopeKey,
    status: 'ready',
    sessions: [{ id: 'session-a' } as Session],
  });

  it('账号切换的过渡帧不暴露旧账号的全量快照', () => {
    expect(usageSessionsForScope(readyState('owner-a'), 'owner-b')).toEqual([]);
  });

  it('只从同一账号的快照消费 deleted 事件', () => {
    const state = readyState('owner-a');
    expect(removeUsageSessionForScope(state, 'owner-a', 'session-a')).toMatchObject({
      scopeKey: 'owner-a',
      status: 'ready',
      sessions: [],
    });
    expect(removeUsageSessionForScope(state, 'owner-b', 'session-a')).toBe(state);
  });

  it('合并实时元数据时保留全量查询的累计 token', () => {
    const fullSession = {
      id: 'session-a',
      title: '历史标题',
      totalTokenUsage: 1000,
    } as Session;
    const liveSession = {
      id: 'session-a',
      title: '最新标题',
      totalTokenUsage: 100,
    } as Session;

    expect(mergeUsageSessionSnapshots(fullSession, liveSession)).toMatchObject({
      id: 'session-a',
      title: '最新标题',
      totalTokenUsage: 1000,
    });
  });

});

describe('cacheHitRate', () => {
  it('输出 token 不进分母 (与逐轮卡片同一公式)', () => {
    expect(
      cacheHitRate({ inputTokens: 100, cacheReadTokens: 300, cacheCreateTokens: 100 }),
    ).toBeCloseTo(0.6);
  });

  it('分母为 0 时返回 null 而不是 0 —— 没有上下文可复用与命中率为零是两回事', () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 })).toBeNull();
  });
});

describe('computeTokenStreak', () => {
  const days = (...keys: string[]) => keys.map((day) => ({ day, tokens: 1000 }));

  it('今日有记录时从今日起算', () => {
    const streak = computeTokenStreak(days('2026-08-20', '2026-08-21', '2026-08-22'), '2026-08-22');
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
    const streak = computeTokenStreak(days('2026-07-30', '2026-07-31', '2026-08-01'), '2026-08-01');
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
    const rows = toUsageDays(payload({ days: [{ day: '2026-08-22', money: zeroMoney }] }));
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
    expect(isUsageHistoryEmpty(payload({ models: [model({ inputTokens: 10 })] }))).toBe(false);
  });
});

describe('filterUsageHistoryPayload', () => {
  const daily = (over: Partial<UsageHistoryPayload['modelDaily'][number]>) => ({
    day: '2026-08-22',
    agentKind: 'codex' as const,
    model: 'gpt-5.5',
    money: zeroMoney,
    apiMoney: zeroMoney,
    subscriptionEstimateMoney: zeroMoney,
    tokens: 0,
    ...over,
  });

  const source = payload({
    days: [
      { day: '2026-08-10', money: zeroMoney, tokens: 300 },
      { day: '2026-08-20', money: zeroMoney, tokens: 60 },
      { day: '2026-08-22', money: zeroMoney, tokens: 120 },
    ],
    modelDaily: [
      daily({
        day: '2026-08-10',
        agentKind: 'claude-code',
        model: 'opus',
        tokens: 300,
        inputTokens: 300,
      }),
      daily({ day: '2026-08-20', tokens: 60, inputTokens: 50, outputTokens: 10 }),
      daily({ day: '2026-08-22', tokens: 120, inputTokens: 100, outputTokens: 20 }),
    ],
  });

  it('按选择的窗口过滤并重新聚合模型与统计值', () => {
    const result = filterUsageHistoryPayload(source, '7d');
    expect(result?.days.map((row) => row.day)).toEqual(['2026-08-20', '2026-08-22']);
    expect(result?.models).toHaveLength(1);
    expect(result?.models[0]).toMatchObject({
      agentKind: 'codex',
      model: 'gpt-5.5',
      inputTokens: 150,
      outputTokens: 30,
    });
    expect(result?.totals).toMatchObject({ todayTokens: 120, last30DaysTokens: 180 });
  });

  it('选中热力图中的历史日时只保留该日并把它作为统计锚点', () => {
    const result = filterUsageHistoryPayload(source, 'day:2026-08-20');
    expect(result?.todayKey).toBe('2026-08-20');
    expect(result?.days.map((row) => row.day)).toEqual(['2026-08-20']);
    expect(result?.modelDaily.map((row) => row.day)).toEqual(['2026-08-20']);
    expect(result?.totals.todayTokens).toBe(60);
    expect(result?.totals.last30DaysTokens).toBe(60);
    expect(result?.streak).toEqual({ current: 1, longest: 1 });
  });

  it('图表保留固定窗口，不随表格筛选范围变化', () => {
    const result = chartUsageHistoryPayload(source);
    expect(result?.modelDaily.map((row) => row.day)).toEqual([
      '2026-08-10',
      '2026-08-20',
      '2026-08-22',
    ]);
    expect(result?.days.map((row) => row.day)).toEqual(source.days.map((row) => row.day));
  });
});

describe('usageActivityIso', () => {
  it('忽略元数据更新时间，优先使用用户发送时间；存量行才回退 updatedAt', () => {
    expect(
      usageActivityIso({
        userSendAt: '2026-08-20T10:00:00.000Z',
        updatedAt: '2026-08-22T10:00:00.000Z',
      }),
    ).toBe('2026-08-20T10:00:00.000Z');
    expect(usageActivityIso({ userSendAt: null, updatedAt: '2026-08-22T10:00:00.000Z' })).toBe(
      '2026-08-22T10:00:00.000Z',
    );
  });
});
