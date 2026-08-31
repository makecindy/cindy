/**
 * modelPickerRows 单测:行展示派生口径对齐桌面 ModelSelector(formatContextWindow /
 * 元信息行拼接 / effort 标签三级优先 / rowEffortOf 选中 live vs 记忆 / rowFastOn 门控 /
 * budgetRowDisabled 三态)。纯逻辑,node env。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers/registry';

import { i18n } from '@/i18n';
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';
import type { MobileModelMemoryAccessors } from '@/session/draftModelMemory';
import {
  budgetRowDisabled,
  buildRowMetaLine,
  compactEffortLabelFor,
  effortLabelFor,
  effortLabelFromRuntime,
  formatContextWindow,
  formatPriceLine,
  modelRowAccessibilityLabel,
  presentPickerPrice,
  providerDisplayTitle,
  rowEffortOf,
  rowFastEditable,
  rowFastOn,
} from '@/session/modelPickerRows';

// 文案已 i18n 化;固定 zh-CN 让字面量断言与语言环境解耦(全局 mock 默认 en-US)。
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

const capabilities: MobileAgentCapabilities = {
  availableModels: [],
  effortLevels: [
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' },
  ],
  permissionModes: [],
  hasFastMode: true,
  planModeSupported: false,
};

const memoryWith = (effort?: string, fast?: boolean): MobileModelMemoryAccessors => ({
  getEffort: () => effort,
  setEffort: () => undefined,
  getFast: () => fast,
  setFast: () => undefined,
});

describe('formatContextWindow(移植桌面)', () => {
  it('1M / 272K / 8192 / 1.5M', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(272_000)).toBe('272K');
    expect(formatContextWindow(8192)).toBe('8K');
    expect(formatContextWindow(999)).toBe('999');
    expect(formatContextWindow(1_500_000)).toBe('1.5M');
  });
});

describe('providerDisplayTitle / formatPriceLine / buildRowMetaLine', () => {
  it('内置供应商用桌面 zh-CN 标题,自定义回退 name', () => {
    expect(providerDisplayTitle({ id: 'anthropic', name: 'x' })).toBe('Anthropic');
    expect(providerDisplayTitle({ id: 'openai', name: 'x' })).toBe('OpenAI');
    expect(providerDisplayTitle({ id: 'xd', name: 'x' })).toBe('Cindy AI');
    expect(providerDisplayTitle({ id: 'my-proxy', name: '我的代理' })).toBe('我的代理');
  });

  it('价格行对齐桌面 priceTip 文案;无价 null', () => {
    expect(formatPriceLine({ inputUsdPerMtok: 3, outputUsdPerMtok: 15 })).toBe(
      '输入 $3 · 输出 $15 / 百万 token',
    );
    expect(formatPriceLine({ inputUsdPerMtok: 1.256, outputUsdPerMtok: 10 })).toBe(
      '输入 $1.26 · 输出 $10 / 百万 token',
    );
    expect(formatPriceLine(undefined)).toBeNull();
  });

  it('元信息行 = 供应商 · 上下文 · 快速;单价改走独立价格块;全空 → null', () => {
    const full = buildRowMetaLine({
      provider: { id: 'xd', name: 'XD Gateway' },
      model: { id: 'gpt-5.5', contextWindow: 272_000, supportsFastMode: true },
    });
    expect(full).toBe('Cindy AI · 272K 上下文 · 快速');

    const minimal = buildRowMetaLine({
      provider: null,
      model: { id: 'm', contextWindow: 0 },
    });
    expect(minimal).toBeNull();
  });
});

function xdProviderWithCost(
  modelId: string,
  cost: { input: number; output: number },
): ProviderView {
  return {
    id: 'xd',
    name: 'Cindy AI',
    agents: ['codex'],
    connected: true,
    models: { codex: [{ id: modelId, cost }] },
  } as unknown as ProviderView;
}

describe('presentPickerPrice', () => {
  it('无报价 → null;有报价无折扣 → 标准价', () => {
    expect(
      presentPickerPrice({
        pricing: null,
        provider: null,
        modelId: 'grok-4.6',
        agentKind: 'codex',
      }),
    ).toBeNull();
    expect(
      presentPickerPrice({
        pricing: { 'grok-4.6': { inputUsdPerMtok: 2, outputUsdPerMtok: 6 } },
        provider: null,
        modelId: 'grok-4.6',
        agentKind: 'codex',
      }),
    ).toEqual({
      title: '每百万 token',
      amountsLine: '输入 $2 · 输出 $6',
      discountLabel: null,
    });
  });

  it('目录折后价与标准价同比例时展示折后价 + 折扣说明', () => {
    expect(
      presentPickerPrice({
        pricing: { 'grok-4.6': { inputUsdPerMtok: 2, outputUsdPerMtok: 6 } },
        provider: xdProviderWithCost('grok-4.6', { input: 0.3, output: 0.9 }),
        modelId: 'grok-4.6',
        agentKind: 'codex',
      }),
    ).toEqual({
      title: '每百万 token',
      amountsLine: '输入 $0.3 · 输出 $0.9',
      discountLabel: '折扣中，较标准价省 85%',
      discountPct: 85,
    });
  });

  it('目录缺失时回退报价 costDiscount', () => {
    expect(
      presentPickerPrice({
        pricing: {
          'grok-4.6': { inputUsdPerMtok: 2, outputUsdPerMtok: 6, costDiscount: 0.4 },
        },
        provider: null,
        modelId: 'grok-4.6',
        agentKind: 'codex',
      }),
    ).toEqual({
      title: '每百万 token',
      amountsLine: '输入 $1.2 · 输出 $3.6',
      discountLabel: '折扣中，较标准价省 40%',
      discountPct: 40,
    });
  });

  it('目录折后价比例不一致时不挂折扣,保持标准价', () => {
    expect(
      presentPickerPrice({
        pricing: { 'grok-4.6': { inputUsdPerMtok: 2, outputUsdPerMtok: 6 } },
        provider: xdProviderWithCost('grok-4.6', { input: 1, output: 6 }),
        modelId: 'grok-4.6',
        agentKind: 'codex',
      }),
    ).toEqual({
      title: '每百万 token',
      amountsLine: '输入 $2 · 输出 $6',
      discountLabel: null,
    });
  });

  it('非 XD 供应商即使 modelId 撞车也不套用 XD 报价', () => {
    const openai = {
      id: 'openai',
      name: 'OpenAI',
      agents: ['codex'],
      connected: true,
      models: { codex: [{ id: 'gpt-5.5', cost: { input: 1, output: 5 } }] },
    } as unknown as ProviderView;
    expect(
      presentPickerPrice({
        pricing: { 'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 15, costDiscount: 0.4 } },
        provider: openai,
        modelId: 'gpt-5.5',
        agentKind: 'codex',
      }),
    ).toBeNull();
  });

  it('折后价小于 1 分时保留最多 4 位小数,不显示成 $0', () => {
    expect(
      presentPickerPrice({
        pricing: { cheap: { inputUsdPerMtok: 0.04, outputUsdPerMtok: 0.04, costDiscount: 0.9 } },
        provider: null,
        modelId: 'cheap',
        agentKind: 'codex',
      }),
    ).toEqual({
      title: '每百万 token',
      amountsLine: '输入 $0.004 · 输出 $0.004',
      discountLabel: '折扣中，较标准价省 90%',
      discountPct: 90,
    });
  });
});

describe('effortLabelFor —— 五级优先(i18n → 模型覆盖 → capabilities → 兼容词表 → 原 id)', () => {
  it('已知档位优先使用当前界面的本地化文案', () => {
    expect(effortLabelFor({ effortDisplayNames: { xhigh: '特高' } }, 'xhigh', capabilities)).toBe('超高');
  });
  it('未知档位回退模型覆盖与 capabilities 标签', () => {
    expect(effortLabelFor({ effortDisplayNames: { custom: '自定义' } }, 'custom', capabilities)).toBe('自定义');
    expect(
      effortLabelFor({}, 'remote', {
        ...capabilities,
        effortLevels: [{ id: 'remote', label: '远程档' }],
      }),
    ).toBe('远程档');
  });
  it('capabilities 缺该档 / 未加载 → 本地化词表', () => {
    expect(effortLabelFor({}, 'minimal', capabilities)).toBe('最小');
    expect(effortLabelFor({}, 'high', null)).toBe('高');
    expect(effortLabelFor({}, 'ultra', null)).toBe('极致');
  });
  it('词表也没有 → 原 id', () => {
    expect(effortLabelFor({}, 'nonexistent', null)).toBe('nonexistent');
  });
});


describe('effortLabelFromRuntime —— 会话摘要按 app 语言覆盖 snapshot 标签', () => {
  it('effortOptions 为 zh-CN 快照时仍随界面语言切换', async () => {
    const previousLanguage = i18n.language;
    const runtime = {
      currentModel: null,
      effortOptions: [{ id: 'xhigh', label: '超高' }],
    };
    try {
      await i18n.changeLanguage('en');
      expect(effortLabelFromRuntime(runtime, 'xhigh')).toBe('Extra High');
      await i18n.changeLanguage('zh-CN');
      expect(effortLabelFromRuntime(runtime, 'xhigh')).toBe('超高');
      expect(effortLabelFromRuntime(runtime, '')).toBe('');
      expect(effortLabelFromRuntime(runtime, null)).toBe('');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});

describe('compactEffortLabelFor —— 英文列表短码', () => {
  it('英文按稳定 effort id 显示 2–3 字母，非英文仍用本地化全称', async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage('en');
      expect(effortLabelFor({}, 'xhigh', capabilities)).toBe('Extra High');
      expect(
        compactEffortLabelFor({ effortDisplayNames: { xhigh: '特高' } }, 'xhigh', capabilities),
      ).toBe('XHi');
      expect(compactEffortLabelFor({}, 'minimal', capabilities)).toBe('Min');
      expect(compactEffortLabelFor({}, 'low', capabilities)).toBe('Lo');
      expect(compactEffortLabelFor({}, 'medium', capabilities)).toBe('Mid');
      expect(compactEffortLabelFor({}, 'high', capabilities)).toBe('Hi');
      expect(compactEffortLabelFor({}, 'ultra', capabilities)).toBe('Ult');
      expect(compactEffortLabelFor({}, 'max', capabilities)).toBe('Max');
      expect(
        compactEffortLabelFor(
          { effortDisplayNames: { 'adaptive-fast': 'Adaptive Fast' } },
          'adaptive-fast',
          capabilities,
        ),
      ).toBe('Adaptive Fast');
      expect(
        compactEffortLabelFor({}, 'adaptive-safe', {
          ...capabilities,
          effortLevels: [{ id: 'adaptive-safe', label: 'Adaptive Safe' }],
        }),
      ).toBe('Adaptive Safe');

      await i18n.changeLanguage('zh-CN');
      expect(compactEffortLabelFor({}, 'high', null)).toBe('高');
      await i18n.changeLanguage('ja');
      expect(compactEffortLabelFor({}, 'ultra', null)).toBe('究極');
      await i18n.changeLanguage('ko');
      expect(compactEffortLabelFor({}, 'medium', null)).toBe('보통');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});

describe('modelRowAccessibilityLabel —— 父行保留完整元信息', () => {
  it('无元信息时只读基础选择动作', () => {
    expect(modelRowAccessibilityLabel({ baseLabel: 'Select Luna' })).toBe('Select Luna');
  });

  it.each([
    ['en', 'Select Luna from OpenAI', 'Subscription', 'Reasoning effort Extra High', 'Fast Mode'],
    ['zh-CN', '选择来源 OpenAI 的模型 Luna', '订阅', '推理强度 超高', '快速模式'],
    ['zh-TW', '選擇來源 OpenAI 的模型 Luna', '訂閱', '推理強度 超高', '快速模式'],
    ['ja', 'OpenAI のモデル Luna を選択', 'サブスク', '推論強度 超高', '高速モード'],
    ['ko', 'OpenAI의 모델 Luna 선택', '구독', '추론 강도 초고', '빠른 모드'],
  ])('在 %s 下把订阅、完整 effort 和 Fast 纳入行级名称', async (
    language,
    expectedBase,
    expectedSubscription,
    expectedEffort,
    expectedFast,
  ) => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage(language);
      const baseLabel = i18n.t('models.picker.selectProviderModelAccessibility', {
        provider: 'OpenAI',
        model: 'Luna',
      });
      const subscriptionLabel = i18n.t('models.picker.subscriptionBadge');
      const effortLabel = i18n.t('models.options.reasoningEffortAccessibility', {
        label: i18n.t('models.options.effortLevels.xhigh'),
      });
      const fastLabel = i18n.t('models.options.fastMode');

      expect([baseLabel, subscriptionLabel, effortLabel, fastLabel]).toEqual([
        expectedBase,
        expectedSubscription,
        expectedEffort,
        expectedFast,
      ]);
      expect(
        modelRowAccessibilityLabel({
          baseLabel,
          subscriptionLabel,
          effortLabel,
          fastLabel,
        }),
      ).toBe([expectedBase, expectedSubscription, expectedEffort, expectedFast].join(', '));
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});

describe('rowEffortOf(桌面同口径:选中 live / 非选中记忆→默认)', () => {
  const model = { id: 'gpt-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };

  it('选中行 → live effort(受支持时)', () => {
    expect(
      rowEffortOf({ model, providerId: 'openai', selected: true, liveEffort: 'high', agentKind: 'codex' }),
    ).toBe('high');
  });
  it('选中行 live 不受支持 → 模型默认', () => {
    expect(
      rowEffortOf({ model, providerId: 'openai', selected: true, liveEffort: 'xhigh', agentKind: 'codex' }),
    ).toBe('medium');
  });
  it('非选中行 → 记忆优先,无记忆落默认', () => {
    expect(
      rowEffortOf({
        model, providerId: 'openai', selected: false, liveEffort: 'high', agentKind: 'codex',
        memory: memoryWith('low'),
      }),
    ).toBe('low');
    expect(
      rowEffortOf({ model, providerId: 'openai', selected: false, liveEffort: 'high', agentKind: 'codex' }),
    ).toBe('medium');
  });
  it('无 effort 档 → null', () => {
    expect(
      rowEffortOf({
        model: { id: 'm', efforts: [], defaultEffort: null },
        providerId: 'openai', selected: false, liveEffort: 'high', agentKind: 'codex',
      }),
    ).toBeNull();
  });

  it('Pi BYOM 不支持 minimal 时只在显式档位内回落', () => {
    expect(
      rowEffortOf({
        model: { id: 'reasoner', efforts: ['low', 'high'], defaultEffort: 'high' },
        providerId: null,
        selected: true,
        liveEffort: 'minimal',
        agentKind: 'pi',
      }),
    ).toBe('high');
  });
});

function providerWith(id: string, modelId: string, supportsFastMode: boolean): ProviderView {
  return {
    id,
    name: id,
    agents: ['codex'],
    connected: true,
    models: { codex: [{ id: modelId, supportsFastMode }] },
  } as unknown as ProviderView;
}

describe('rowFastEditable / rowFastOn(严格 per-(供应商, 模型))', () => {
  const model = { id: 'gpt-5.5', efforts: [], defaultEffort: null, supportsFastMode: true };

  it('fastEditable = agent gate × 该来源条目的 supportsFastMode(同 id 跨来源可分叉)', () => {
    const openai = providerWith('openai', 'gpt-5.5', true);
    const xd = providerWith('xd', 'gpt-5.5', false); // 网关剥 fast → false
    expect(rowFastEditable({ provider: openai, modelId: 'gpt-5.5', agentKind: 'codex', hasFastModeCap: true })).toBe(true);
    expect(rowFastEditable({ provider: xd, modelId: 'gpt-5.5', agentKind: 'codex', hasFastModeCap: true })).toBe(false);
    expect(rowFastEditable({ provider: openai, modelId: 'gpt-5.5', agentKind: 'codex', hasFastModeCap: false })).toBe(false);
  });

  it('rowFastOn:选中行 live;非选中行读记忆;门控关死一切', () => {
    const base = { model, providerId: 'openai', agentKind: 'codex' as const };
    expect(rowFastOn({ ...base, selected: true, liveFastMode: true, fastEditable: true })).toBe(true);
    expect(rowFastOn({ ...base, selected: false, liveFastMode: true, fastEditable: true, memory: memoryWith(undefined, true) })).toBe(true);
    expect(rowFastOn({ ...base, selected: false, liveFastMode: true, fastEditable: true })).toBe(false);
    expect(rowFastOn({ ...base, selected: true, liveFastMode: true, fastEditable: false })).toBe(false);
  });
});

describe('budgetRowDisabled(折扣版置灰三态)', () => {
  it("只有 codex/ 前缀且被控端明确 absent 才置灰;unknown 不误伤", () => {
    expect(budgetRowDisabled('codex/gpt-5.5', 'absent')).toBe(true);
    expect(budgetRowDisabled('codex/gpt-5.5', 'present')).toBe(false);
    expect(budgetRowDisabled('codex/gpt-5.5', 'unknown')).toBe(false);
    expect(budgetRowDisabled('gpt-5.5', 'absent')).toBe(false);
  });
});
