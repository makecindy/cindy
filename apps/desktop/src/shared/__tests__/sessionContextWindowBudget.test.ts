import { describe, expect, it } from 'vitest';

import {
  buildContextWindowBudgetOptions,
  contextWindowBudgetTierPercent,
  normalizeContextWindowBudget,
  resolveContextWindowBudgetBase,
} from '../sessionContextWindowBudget';

describe('normalizeContextWindowBudget', () => {
  it('accepts sane token counts and rounds them', () => {
    expect(normalizeContextWindowBudget(300_000)).toBe(300_000);
    expect(normalizeContextWindowBudget(300_000.4)).toBe(300_000);
  });

  it('treats non-numbers and sub-floor values as "follow the model default"', () => {
    for (const value of [null, undefined, '300000', Number.NaN, -1, 999]) {
      expect(normalizeContextWindowBudget(value)).toBeNull();
    }
  });

  it('clamps absurd magnitudes instead of rejecting them', () => {
    expect(normalizeContextWindowBudget(500_000_000)).toBe(100_000_000);
  });
});

describe('档位基准与百分比（展示层共用同一口径）', () => {
  it('基准取物理上限与模型级上限的更紧者，缺省时退回默认窗口', () => {
    expect(resolveContextWindowBudgetBase({ defaultWindow: 1_000_000 })).toBe(1_000_000);
    expect(resolveContextWindowBudgetBase({ defaultWindow: 272_000, maxWindow: 1_050_000 })).toBe(1_050_000);
    expect(resolveContextWindowBudgetBase({ defaultWindow: 272_000, maxWindow: 1_050_000, modelLimit: 300_000 }))
      .toBe(300_000);
    // 上限字段是畸形值（0 / 负数 / NaN）时不参与，退回默认窗口。
    expect(resolveContextWindowBudgetBase({ defaultWindow: 300_000, maxWindow: 0, modelLimit: Number.NaN }))
      .toBe(300_000);
    expect(resolveContextWindowBudgetBase({ defaultWindow: null, maxWindow: null, modelLimit: null })).toBeNull();
  });

  it('每一行都用同一个公式算百分比（含默认档与旧值补档）', () => {
    // 1,048,576 的窗口：默认档 = 100%，两个比例档 = 25% / 50%。
    expect(contextWindowBudgetTierPercent(1_048_576, 1_048_576)).toBe(100);
    expect(contextWindowBudgetTierPercent(262_144, 1_048_576)).toBe(25);
    expect(contextWindowBudgetTierPercent(524_288, 1_048_576)).toBe(50);
    // Codex 形态（默认 272K / 上限 1.05M）：默认档不是满窗，如实显示 26%。
    expect(contextWindowBudgetTierPercent(272_000, 1_050_000)).toBe(26);
    // 旧值补的当前档：按真实占比四舍五入，不再是「没有百分比」的另一种行。
    expect(contextWindowBudgetTierPercent(300_000, 1_000_000)).toBe(30);
    expect(contextWindowBudgetTierPercent(333_333, 1_000_000)).toBe(33);
  });

  it('基准未知或输入非法时返回 null（该行只显示绝对值）', () => {
    expect(contextWindowBudgetTierPercent(1_000_000, null)).toBeNull();
    expect(contextWindowBudgetTierPercent(1_000_000, 0)).toBeNull();
    expect(contextWindowBudgetTierPercent(1_000_000, Number.NaN)).toBeNull();
    expect(contextWindowBudgetTierPercent(0, 1_000_000)).toBeNull();
    expect(contextWindowBudgetTierPercent(Number.NaN, 1_000_000)).toBeNull();
  });
});

describe('buildContextWindowBudgetOptions', () => {
  it('returns nothing when the route window is unknown', () => {
    expect(buildContextWindowBudgetOptions({ defaultWindow: null })).toEqual([]);
  });

  it('gives the model default plus exact 25%/50% tiers on a 1M window', () => {
    // 基准 = 1M（默认=上限）→ 25% = 250K、50% = 500K；100% 就是默认档，不单列。
    expect(buildContextWindowBudgetOptions({ defaultWindow: 1_000_000 })).toEqual([
      { tokens: 250_000, kind: 'percent' },
      { tokens: 500_000, kind: 'percent' },
      { tokens: 1_000_000, kind: 'default' },
    ]);
  });

  it('keeps percentages exact instead of snapping to a K grid', () => {
    // 1,048,576 的 25% / 50% 是 262,144 / 524,288 —— 不取整到 256K / 512K。
    const options = buildContextWindowBudgetOptions({ defaultWindow: 1_048_576 });
    expect(options).toEqual([
      { tokens: 262_144, kind: 'percent' },
      { tokens: 524_288, kind: 'percent' },
      { tokens: 1_048_576, kind: 'default' },
    ]);
  });

  it('only offers the default tier on a 256K-class window (below the tier floor)', () => {
    // 512K 的 50% = 256K 保留；256K 的 50% = 128K < 200K 阈值 → 只剩默认档。
    expect(buildContextWindowBudgetOptions({ defaultWindow: 512_000 })).toEqual([
      { tokens: 256_000, kind: 'percent' },
      { tokens: 512_000, kind: 'default' },
    ]);
    expect(buildContextWindowBudgetOptions({ defaultWindow: 256_000 })).toEqual([
      { tokens: 256_000, kind: 'default' },
    ]);
  });

  it('keeps the 100% tier so a lowered default can still reach the physical max', () => {
    // Codex GPT 系：默认 272K、物理上限 1.05M。25% = 262.5K 与 50%/100% 一起会让档数超上限，
    // 按「优先保留大比例」丢掉 25%，保证能开满窗口且仍是三档。
    const options = buildContextWindowBudgetOptions({
      defaultWindow: 272_000,
      maxWindow: 1_050_000,
    });
    expect(options).toEqual([
      { tokens: 272_000, kind: 'default' },
      { tokens: 525_000, kind: 'percent' },
      { tokens: 1_050_000, kind: 'percent' },
    ]);
  });

  it('lets a tighter model-level limit become the percentage base', () => {
    // 物理 1.05M，但用户在高级设置里设了 300K：基准变 300K → 50% = 150K 低于阈值不出现，
    // 只剩「默认 + 100% 上限档」。
    const options = buildContextWindowBudgetOptions({
      defaultWindow: 272_000,
      maxWindow: 1_050_000,
      modelLimit: 300_000,
    });
    expect(options).toEqual([
      { tokens: 272_000, kind: 'default' },
      { tokens: 300_000, kind: 'percent' },
    ]);
  });

  it('never lets a percentage tier exceed its base', () => {
    for (const base of [1_000_000, 1_048_576, 991_808, 512_000]) {
      for (const option of buildContextWindowBudgetOptions({ defaultWindow: base })) {
        expect(option.tokens).toBeLessThanOrEqual(base);
      }
    }
  });
});
