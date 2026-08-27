/**
 * effortResolution 单测 —— 用例与 apps/desktop 的 sourceSwitch.test.ts 同源(实现从那里下沉,
 * 桌面侧继续经 re-export 覆盖同一实现;这里保证共享包独立可测、手机端消费口径有据可依)。
 */
import { describe, it, expect } from 'vitest';

import {
  resolveEffort,
  resolveRequestedEffort,
  resolveIntentReselectEffort,
  resolveProviderSwitchEffort,
  clampEffortToSupported,
} from '../effortResolution.js';
import type { Effort } from '../types.js';

describe('resolveEffort —— 选中模型后 effort 落档优先级', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('无 effort 档(efforts 为空)→ 始终 low(占位,UI 不显示)', () => {
    expect(
      resolveEffort({ efforts: [], defaultEffort: null, activeEffort: 'high', preferred: 'max' }),
    ).toBe('low');
  });

  it('preferred 最高优先(仍受支持时)', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        preferred: 'max',
        providerEffort: 'medium',
        rememberedEffort: 'xhigh',
      }),
    ).toBe('max');
  });

  it('preferred 不受支持 → 跳过,落到 providerEffort((agent,provider,model) 精确记忆)', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        activeEffort: 'low',
        preferred: 'max', // 不在 efforts
        providerEffort: 'medium',
        rememberedEffort: 'high',
      }),
    ).toBe('medium');
  });

  it('providerEffort > rememberedEffort:同模型跨来源记忆精确恢复', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        providerEffort: 'xhigh',
        rememberedEffort: 'medium',
      }),
    ).toBe('xhigh');
  });

  it('无 provider 记忆 → 落到 per-model rememberedEffort', () => {
    expect(
      resolveEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        activeEffort: 'low',
        rememberedEffort: 'medium',
      }),
    ).toBe('medium');
  });

  it('记忆都不受支持 → 沿用当前 activeEffort(仍受支持时)', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        activeEffort: 'medium',
        providerEffort: 'max', // 不在 efforts
        rememberedEffort: 'xhigh', // 不在 efforts
      }),
    ).toBe('medium');
  });

  it('全无可用 → 模型默认 defaultEffort', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        activeEffort: 'max', // 不在 efforts
      }),
    ).toBe('high');
  });

  it('defaultEffort 为 null → 落 efforts 首档', () => {
    expect(
      resolveEffort({
        efforts: ['low', 'high'],
        defaultEffort: null,
        activeEffort: 'medium', // 不在 efforts
      }),
    ).toBe('low');
  });
});

describe('resolveEffort —— defaultEffort 兜底校验(catalog 病态数据防御)', () => {
  it('defaultEffort 不在 efforts 内 → 落 efforts 首档,不返回非法档', () => {
    expect(
      resolveEffort({ efforts: ['minimal', 'low', 'medium'], defaultEffort: 'high', activeEffort: 'xhigh' }),
    ).toBe('minimal');
  });
  it('defaultEffort 缺失 → 落 efforts 首档,不落幽灵 high', () => {
    expect(
      resolveEffort({ efforts: ['minimal', 'low'], defaultEffort: null, activeEffort: 'xhigh' }),
    ).toBe('minimal');
  });
});

describe('resolveRequestedEffort —— 面板/收藏显式档 vs 本端再查目录', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];

  it('目录查空时保留显式档,不落 resolveEffort 的占位 low', () => {
    expect(
      resolveRequestedEffort({
        requested: 'high',
        efforts: [],
        defaultEffort: null,
        activeEffort: 'low',
        providerEffort: 'low',
      }),
    ).toBe('high');
  });

  it('目录支持该档 → 用显式档,压过记忆/当前档', () => {
    expect(
      resolveRequestedEffort({
        requested: 'high',
        efforts: EFFORTS,
        defaultEffort: 'low',
        activeEffort: 'low',
        providerEffort: 'low',
      }),
    ).toBe('high');
  });

  it('目录非空但不含显式档 → 回落 resolveEffort,不硬塞', () => {
    expect(
      resolveRequestedEffort({
        requested: 'xhigh',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        activeEffort: 'low',
      }),
    ).toBe('low');
  });

  it('没有显式档 → 与 resolveEffort 同结果', () => {
    expect(
      resolveRequestedEffort({
        efforts: EFFORTS,
        defaultEffort: 'medium',
        activeEffort: 'low',
      }),
    ).toBe('low');
  });
});

describe('resolveIntentReselectEffort —— 意图期改选不把空串回落成旧 high', () => {
  it('空串 = 目标明确无档,不继承旧意图 high', () => {
    expect(resolveIntentReselectEffort('', 'high')).toBeUndefined();
  });

  it('非空新档压过旧意图', () => {
    expect(resolveIntentReselectEffort('medium', 'high')).toBe('medium');
  });

  it('调用方没给新档 → 才继承旧意图', () => {
    expect(resolveIntentReselectEffort(undefined, 'high')).toBe('high');
  });

  it('两边都空 → 不传 override', () => {
    expect(resolveIntentReselectEffort(undefined, undefined)).toBeUndefined();
    expect(resolveIntentReselectEffort('', '')).toBeUndefined();
  });
});

describe('resolveProviderSwitchEffort —— 同模型只切来源(严格 per-供应商,不沿用 activeEffort)', () => {
  const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('preferred 最高优先(仍受支持时)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: 'medium',
        preferred: 'max',
        fallbackEffort: 'low',
      }),
    ).toBe('max');
  });

  it('新来源有该模型记忆 → 恢复 providerEffort', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: 'xhigh',
        fallbackEffort: 'low',
      }),
    ).toBe('xhigh');
  });

  it('【bug 回归】新来源无记忆 → 落模型默认,绝不沿用 fallback(=当前来源 activeEffort)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: EFFORTS,
        defaultEffort: 'high',
        providerEffort: undefined,
        fallbackEffort: 'max', // = A 来源当前档,绝不能被选中
      }),
    ).toBe('high');
  });

  it('providerEffort 不受目标模型支持 → 跳过,落模型默认', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        providerEffort: 'max', // 不在 efforts
        fallbackEffort: 'low',
      }),
    ).toBe('high');
  });

  it('无记忆、defaultEffort 为 null → efforts 首档(仍不取 fallback)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: ['medium', 'high'],
        defaultEffort: null,
        fallbackEffort: 'max',
      }),
    ).toBe('medium');
  });

  it('模型无 effort 档(efforts 为空)→ fallbackEffort(占位,UI 不显示 effort)', () => {
    expect(
      resolveProviderSwitchEffort({
        efforts: [],
        defaultEffort: null,
        fallbackEffort: 'high',
      }),
    ).toBe('high');
  });
});

describe('clampEffortToSupported —— 未门控入口按模型能力 clamp(issue #456)', () => {
  const XHIGH_MODEL: readonly Effort[] = ['low', 'medium', 'high', 'xhigh']; // 如 gpt-5.5
  const ULTRA_MODEL: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']; // 如 gpt-5.6-sol

  it('模型支持该档 → 原样保留,不降级(保 #352)', () => {
    expect(clampEffortToSupported('ultra', ULTRA_MODEL)).toBe('ultra');
    expect(clampEffortToSupported('max', ULTRA_MODEL)).toBe('max');
    expect(clampEffortToSupported('high', XHIGH_MODEL)).toBe('high');
  });

  it('超额档(gpt-5.5 + max/ultra)→ clamp 到最高兼容档 xhigh', () => {
    expect(clampEffortToSupported('max', XHIGH_MODEL)).toBe('xhigh');
    expect(clampEffortToSupported('ultra', XHIGH_MODEL)).toBe('xhigh');
  });

  it('clamp 到「rank ≤ 请求档」的最高受支持档(跳过缺失中间档)', () => {
    const SPARSE: readonly Effort[] = ['low', 'high']; // 无 medium/xhigh/max
    expect(clampEffortToSupported('xhigh', SPARSE)).toBe('high'); // high(3) ≤ xhigh(4)
    expect(clampEffortToSupported('medium', SPARSE)).toBe('low'); // low(1) ≤ medium(2);high(3) 超了
  });

  it('请求档低于全部受支持档 → 最低受支持档(floor,绝不上调到模型默认,#456 review)', () => {
    // minimal 落在只支持 low+ 的模型:clamp 到 floor(low),不上调到 default(high)——
    // 否则存量 minimal 定时任务被静默升级、变贵(codex 旧行为是 minimal→low)。
    expect(clampEffortToSupported('minimal', XHIGH_MODEL)).toBe('low');
    expect(clampEffortToSupported('minimal', ['medium', 'high', 'xhigh'])).toBe('medium'); // floor=medium
    expect(clampEffortToSupported('low', ['high', 'xhigh'])).toBe('high'); // 请求 low 低于全部 → floor=high
  });

  it('efforts 空/缺失 → 原样透传(模型未声明门控,no-break)', () => {
    expect(clampEffortToSupported('ultra', [])).toBe('ultra');
    expect(clampEffortToSupported('max', undefined)).toBe('max');
  });

  it('effort 为空(null/undefined/空串)→ 原样返回(留空 = 不改,不被 clamp 上调)', () => {
    expect(clampEffortToSupported(undefined, XHIGH_MODEL)).toBeUndefined();
    expect(clampEffortToSupported(null, XHIGH_MODEL)).toBeNull();
    // 空串:不在 EFFORT_ORDER 内,若不透传会被当"未知档"clamp 到模型最高受支持档(#456 review)。
    expect(clampEffortToSupported('', XHIGH_MODEL)).toBe('');
  });
});
