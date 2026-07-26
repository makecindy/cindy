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
import { buildTurnUsageTooltipLines } from '../turnUsageTooltip';

// t 桩: 返回 `key` 或 `key|{json opts}`, 便于断言哪条 i18n key 被用到及其插值。
const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}|${JSON.stringify(opts)}` : key) as unknown as TFunction;

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
          l.includes('¥6.30'),
      ),
    ).toBe(true);
    expect(
      out.some(
        (l) =>
          l.startsWith('usageDetails.modelCostLine') &&
          l.includes('Haiku 4.5') &&
          l.includes('¥5.36'),
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
          amount: expect.closeTo(6.298, 10),
          currency: 'CNY',
          approximate: true,
          kind: 'actual-cost',
          estimateReasons: ['fixed-fx', 'legacy-usd'],
        },
      },
      {
        model: 'claude-haiku-4-5',
        money: {
          amount: expect.closeTo(5.36, 10),
          currency: 'CNY',
          approximate: true,
          kind: 'actual-cost',
          estimateReasons: ['fixed-fx', 'legacy-usd'],
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
          amount: expect.closeTo(6.03, 10),
          currency: 'CNY',
          approximate: true,
          kind: 'actual-cost',
          estimateReasons: ['fixed-fx', 'legacy-usd'],
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
