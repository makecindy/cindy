/**
 * turnUsageTooltip.test.ts
 * ---------------------------------------------------------------------------
 * Per-turn 成本 tooltip 的纯函数单测:
 *   - formatModelShort: model id → 简短可读标签
 *   - buildTurnUsageTooltipLines: ≥2 模型时展开「按模型成本明细」并抑制笼统 modelLine
 *   - normalizeTurnUsageDetails: perModelCost 往返 / 清洗 / 缺字段降级 (shared 模块经
 *     renderer 入口测, 覆盖 vitest include 未含的 src/shared 路径)
 */

import type { TFunction } from 'i18next';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/brandRegion', () => ({
  CURRENT_CINDY_REGION: 'cn',
  CURRENT_APP_ID: 'com.xd.cindycn',
}));

import { buildTurnUsageDetails, normalizeTurnUsageDetails } from '../../../shared/turnUsageDetails';
import { formatModelShort } from '../usageFormat';
import {
  buildTurnUsageTooltipLines,
  formatOutputTokenRate,
  formatTurnDuration,
} from '../turnUsageTooltip';

// t 桩: 返回 `key` 或 `key|{json opts}`, 便于断言哪条 i18n key 被用到及其插值。
const t = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'usageDetails.durationSeconds') return `${opts?.value}秒`;
  if (key === 'usageDetails.durationMinutesSeconds') {
    return `${opts?.minutes}分 ${opts?.seconds}秒`;
  }
  return opts ? `${key}|${JSON.stringify(opts)}` : key;
}) as unknown as TFunction;

describe('formatModelShort', () => {
  it('claude 家族 → 简短标签 (剥 [1m] / 尾部日期)', () => {
    expect(formatModelShort('claude-opus-4-8[1m]')).toBe('Opus 4.8');
    expect(formatModelShort('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelShort('claude-sonnet-4-6')).toBe('Sonnet 4.6');
  });

  it('gpt / codex 预算前缀', () => {
    expect(formatModelShort('gpt-5.5')).toBe('GPT-5.5');
    expect(formatModelShort('codex/gpt-5.5[1m]')).toBe('GPT-5.5');
  });

  it('认不出 → 回退 (空串原样)', () => {
    expect(formatModelShort('deepseek-v3')).toBe('deepseek-v3');
    expect(formatModelShort('')).toBe('');
  });
});

describe('formatOutputTokenRate', () => {
  it('does not round a positive sub-0.1 TPS rate down to zero', () => {
    const details = buildTurnUsageDetails({ outputTokens: 1, durationMs: 25_000 })!;
    expect(formatOutputTokenRate(details)).toBe('<0.1');
  });
});

describe('buildTurnUsageTooltipLines — 按模型成本明细', () => {
  function lines(
    perModelCost?: Array<{ model: string; costUsd: number }>,
    costUsd = 1.74,
  ): string[] {
    const details = buildTurnUsageDetails({
      inputTokens: 133,
      outputTokens: 9_899,
      cacheReadTokens: 5_289_380,
      cacheCreateTokens: 251_573,
      models: perModelCost?.map((m) => m.model),
      perModelCost,
    })!;
    return buildTurnUsageTooltipLines({ details, t, costUsd });
  }

  it('≥2 模型 → header + 每模型一行 (含 subagent 跑的 Haiku), 抑制笼统 modelLine', () => {
    const out = lines([
      { model: 'claude-opus-4-8', costUsd: 0.94 },
      { model: 'claude-haiku-4-5-20251001', costUsd: 0.8 },
    ]);
    expect(out).toContain('usageDetails.costBreakdownHeader');
    expect(
      out.some(
        (l) =>
          l.startsWith('usageDetails.modelCostLine') &&
          l.includes('Opus 4.8') &&
          l.includes('$0.94'),
      ),
    ).toBe(true);
    expect(
      out.some(
        (l) =>
          l.startsWith('usageDetails.modelCostLine') &&
          l.includes('Haiku 4.5') &&
          l.includes('$0.80'),
      ),
    ).toBe(true);
    expect(out.some((l) => l.startsWith('usageDetails.modelLine'))).toBe(false);
  });

  it('单模型 (perModelCost 长度 1) → 不展开, 保留 modelLine', () => {
    const out = lines([{ model: 'claude-opus-4-8', costUsd: 0.94 }]);
    expect(out).not.toContain('usageDetails.costBreakdownHeader');
    expect(out.some((l) => l.startsWith('usageDetails.modelLine'))).toBe(true);
  });

  it('无 perModelCost 字段 → 不展开', () => {
    const out = lines(undefined);
    expect(out).not.toContain('usageDetails.costBreakdownHeader');
  });
});

describe('buildTurnUsageTooltipLines — 建议行 (只在真正有价值时出现)', () => {
  function suggestionLines(tokens: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreateTokens?: number;
  }): string[] {
    const details = buildTurnUsageDetails({ outputTokens: 100, ...tokens })!;
    return buildTurnUsageTooltipLines({ details, t, costUsd: 1 }).filter((l) =>
      l.startsWith('usageDetails.suggestionLine'),
    );
  }

  it('总量大但缓存命中率高 (健康长会话) → 无建议', () => {
    // 1.6M total / 88% 命中: 旧 largeTurn 会在这里误报
    const out = suggestionLines({
      inputTokens: 4_400,
      outputTokens: 8_400,
      cacheReadTokens: 1_400_000,
      cacheCreateTokens: 180_000,
    });
    expect(out).toEqual([]);
  });

  it('大输出 → 无建议 (outputHeavy 已删)', () => {
    const out = suggestionLines({ inputTokens: 1_000, outputTokens: 50_000 });
    expect(out).toEqual([]);
  });

  it('大量输入且缓存几乎未命中 → 提示 lowCache', () => {
    const out = suggestionLines({ inputTokens: 60_000, cacheReadTokens: 5_000 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('usageDetails.suggestion.lowCache');
  });

  it('缓存未命中但输入量不足 50k → 无建议 (小额浪费不打扰)', () => {
    const out = suggestionLines({ inputTokens: 20_000, cacheReadTokens: 1_000 });
    expect(out).toEqual([]);
  });
});

describe('buildTurnUsageTooltipLines — 无金额 (token 回退) tooltip', () => {
  const details = buildTurnUsageDetails({
    inputTokens: 12_400,
    outputTokens: 8_900,
    cacheReadTokens: 2_000_000,
    cacheCreateTokens: 86_400,
    model: 'claude-opus-5',
  })!;

  it('不传 money/costUsd → 跳过费用行, 保留 token / 缓存 / 模型行', () => {
    const out = buildTurnUsageTooltipLines({ details, t });
    expect(out.some((l) => l.startsWith('usageDetails.costLine'))).toBe(false);
    expect(out.some((l) => l.startsWith('usageDetails.valueLine'))).toBe(false);
    expect(out.some((l) => l.startsWith('usageDetails.tokenLine'))).toBe(true);
    expect(out.some((l) => l.startsWith('usageDetails.cacheLine'))).toBe(true);
    expect(out.some((l) => l.startsWith('usageDetails.modelLine'))).toBe(true);
  });

  it('无金额 → 末尾追加「取不到报价」说明, 避免被读成"这轮不花钱"', () => {
    const out = buildTurnUsageTooltipLines({ details, t });
    expect(out[out.length - 1]).toBe('usageDetails.noBilledCost');
  });

  it('有金额 → 不出现该说明行', () => {
    expect(
      buildTurnUsageTooltipLines({ details, t, costUsd: 0.42 }),
    ).not.toContain('usageDetails.noBilledCost');
    expect(
      buildTurnUsageTooltipLines({
        details,
        t,
        money: { amount: 3.5, currency: 'CNY', approximate: false, kind: 'actual-cost' },
      }),
    ).not.toContain('usageDetails.noBilledCost');
  });

  it('金额为 0 / 负 → 视同无金额, 仍给说明行 (绝不显示 $0.00 当事实)', () => {
    const zero = buildTurnUsageTooltipLines({ details, t, costUsd: 0 });
    expect(zero).toContain('usageDetails.noBilledCost');
    const negative = buildTurnUsageTooltipLines({ details, t, costUsd: -1 });
    expect(negative).toContain('usageDetails.noBilledCost');
  });

  // 说明行刻意**不断言原因**:这一层分不清「价格字段缺失」与「显式全 0 的免费模型」,
  // 断言"取不到报价"会对后者给出错误解释。
  it('说明行不断言原因 (免费模型与缺价轮共用同一句)', () => {
    const out = buildTurnUsageTooltipLines({ details, t });
    expect(out).toContain('usageDetails.noBilledCost');
    expect(out.some((l) => l.includes('priceUnavailable'))).toBe(false);
  });
});

describe('buildTurnUsageTooltipLines — 输出速度', () => {
  it('有输出 token 和有效耗时时显示平均 TPS', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 2,
      outputTokens: 235,
      cacheCreateTokens: 25_470,
      durationMs: 8_954,
      model: 'anthropic/claude-opus-5',
    })!;

    expect(buildTurnUsageTooltipLines({ details, t, costUsd: 0.17 })).toContain(
      'usageDetails.performanceRateLine|{"rate":"26.2"}',
    );
  });

  it('does not hide a valid sub-100ms generation behind an arbitrary threshold', () => {
    const details = buildTurnUsageDetails({ outputTokens: 2, durationMs: 50 })!;
    expect(buildTurnUsageTooltipLines({ details, t })).toContain(
      'usageDetails.performanceRateLine|{"rate":"40"}',
    );
  });

  it('旧消息没有耗时时不显示 TPS', () => {
    const details = buildTurnUsageDetails({ outputTokens: 235 })!;
    expect(
      buildTurnUsageTooltipLines({ details, t }).some((line) =>
        line.startsWith('usageDetails.performanceLine'),
      ),
    ).toBe(false);
  });

  it('shows full-turn wall-clock separately from generation speed', () => {
    const details = buildTurnUsageDetails({
      outputTokens: 100,
      durationMs: 2_000,
      turnDurationMs: 12_345,
    })!;
    const out = buildTurnUsageTooltipLines({ details, t });
    expect(out).toContain('usageDetails.performanceLine|{"rate":"50","duration":"12.3秒"}');
  });

  it('shows wall-clock alone without a fake missing-speed placeholder', () => {
    const details = buildTurnUsageDetails({
      inputTokens: 100,
      turnDurationMs: 12_345,
    })!;
    expect(buildTurnUsageTooltipLines({ details, t })).toContain(
      'usageDetails.timeLine|{"duration":"12.3秒"}',
    );
  });

  it('normalizes rounded minute boundaries instead of showing 1m 60s', () => {
    expect(formatTurnDuration(59_960)).toBe('1m 00s');
    expect(formatTurnDuration(119_600)).toBe('2m 00s');
    expect(formatTurnDuration(12_345, t)).toBe('12.3秒');
    expect(formatTurnDuration(119_600, t)).toBe('2分 00秒');
  });
});

describe('normalizeTurnUsageDetails — perModelCost 往返 / 清洗', () => {
  it('合法数组往返, 过滤空 model / cost<=0', () => {
    const d = normalizeTurnUsageDetails({
      inputTokens: 10,
      outputTokens: 20,
      perModelCost: [
        { model: 'claude-opus-4-8', costUsd: 0.94 },
        { model: '', costUsd: 1 },
        { model: 'x', costUsd: 0 },
        { model: 'claude-haiku-4-5', costUsd: 0.8 },
      ],
    });
    expect(d!.perModelCost).toEqual([
      {
        model: 'claude-opus-4-8',
        money: {
          amount: expect.closeTo(0.94, 10),
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      },
      {
        model: 'claude-haiku-4-5',
        money: {
          amount: expect.closeTo(0.8, 10),
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      },
    ]);
  });

  it('同模型多项 → 累加', () => {
    const d = normalizeTurnUsageDetails({
      inputTokens: 10,
      outputTokens: 20,
      perModelCost: [
        { model: 'claude-opus-4-8', costUsd: 0.5 },
        { model: 'claude-opus-4-8', costUsd: 0.4 },
      ],
    });
    expect(d!.perModelCost).toEqual([
      {
        model: 'claude-opus-4-8',
        money: {
          amount: expect.closeTo(0.9, 10),
          currency: 'USD',
          approximate: false,
          kind: 'actual-cost',
        },
      },
    ]);
  });

  it('缺 perModelCost 字段 → undefined, 其它明细仍构建', () => {
    const d = normalizeTurnUsageDetails({ inputTokens: 10, outputTokens: 20 });
    expect(d!.perModelCost).toBeUndefined();
    expect(d!.totalTokens).toBe(30);
  });
});
