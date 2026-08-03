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
  effortLabelFor,
  formatContextWindow,
  formatPriceLine,
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

  it('元信息行 = 供应商 · 上下文 · 单价 · 快速;全空 → null', () => {
    const full = buildRowMetaLine({
      provider: { id: 'xd', name: 'XD Gateway' },
      model: { id: 'gpt-5.5', contextWindow: 272_000, supportsFastMode: true },
      pricing: { 'gpt-5.5': { inputUsdPerMtok: 3, outputUsdPerMtok: 15 } },
    });
    expect(full).toBe('Cindy AI · 272K 上下文 · 输入 $3 · 输出 $15 / 百万 token · 快速');

    const minimal = buildRowMetaLine({
      provider: null,
      model: { id: 'm', contextWindow: 0 },
      pricing: null,
    });
    expect(minimal).toBeNull();
  });
});

describe('effortLabelFor —— 四级优先(模型覆盖 → capabilities → 中文词表 → 原 id)', () => {
  it('模型 effortDisplayNames 覆盖优先', () => {
    expect(effortLabelFor({ effortDisplayNames: { xhigh: '特高' } }, 'xhigh', capabilities)).toBe('特高');
  });
  it('无覆盖 → capabilities effortLevels label', () => {
    expect(effortLabelFor({}, 'xhigh', capabilities)).toBe('Extra High');
  });
  it('capabilities 缺该档 / 未加载 → 中文词表兜底', () => {
    expect(effortLabelFor({}, 'minimal', capabilities)).toBe('最小');
    expect(effortLabelFor({}, 'high', null)).toBe('高');
    expect(effortLabelFor({}, 'ultra', null)).toBe('极致');
  });
  it('词表也没有 → 原 id', () => {
    expect(effortLabelFor({}, 'nonexistent', null)).toBe('nonexistent');
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
