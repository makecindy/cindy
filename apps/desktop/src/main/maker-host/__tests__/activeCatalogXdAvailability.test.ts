/**
 * active-catalog XD 网关权威模型清单重建单测(2026-07-19 统一重构后语义)。
 * 不变量:
 *   - 空列表 = 不展示任何 XD 模型;清除后不回退任何静态数据;
 *   - 元数据只信服务端下发 + 确定性默认值(不再回落产品目录条目):
 *       efforts 缺失 → 合成 3 档(low/medium/high,默认 high);显式 [] → 不可调;
 *       supportsFastMode 缺失 → true;defaultEnabled 缺失 → 默认可见;
 *   - perAgent 覆盖块按 tab 应用(gpt 系 cc/codex 的 Fast / 窗口分叉);
 *   - tab 归属:服务端 agents > 仅 claude-code;
 *   - 其它供应商永不受影响。
 * 另含 anthropic 权威清单 setter 的同款语义单测。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type CatalogModel } from '@cindy/model-providers';

import {
  getActiveCatalog,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
  setXdGatewayModels,
} from '../active-catalog.js';

function xdModels(agent: 'claude-code' | 'codex') {
  const xd = getActiveCatalog().providers.find((p) => p.id === 'xd');
  return xd?.models[agent] ?? [];
}

afterEach(() => {
  setXdGatewayModels([]);
  setAnthropicDiscoveredModels([]);
  setActiveCatalog(BUNDLED_CATALOG);
});

describe('XD 网关权威模型清单重建', () => {
  it('未拉到实时清单时不暴露任何 XD 模型', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex')).toEqual([]);
  });

  it('显式空列表保持 XD 模型不可用', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([]);
    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex')).toEqual([]);
  });

  it('未登记模型的确定性默认:3 档 effort + fast=true + 仅 cc tab + 200k 窗口', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ id: 'brand-new-model' }]);

    const cc = xdModels('claude-code');
    expect(cc.map((m) => m.id)).toEqual(['brand-new-model']);
    expect(cc[0]).toMatchObject({
      name: 'brand-new-model',
      contextWindow: 200_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      supportsFastMode: true,
    });
    expect(xdModels('codex')).toEqual([]);
  });

  it('显式登记 efforts=[] 表示不可调,不合成 3 档;fast 显式 false 尊重', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      { id: 'claude-haiku-4-5', name: 'Haiku 4.5', efforts: [], supportsFastMode: false },
    ]);
    const cc = xdModels('claude-code');
    expect(cc[0]).toMatchObject({
      name: 'Haiku 4.5',
      efforts: [],
      defaultEffort: null,
      supportsFastMode: false,
    });
  });

  it('服务端 agents 决定 tab 归属:标了 codex 的条目两个 tab 都进,元数据以服务端为准', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'gpt-5.6-sol',
        agents: ['claude-code', 'codex'],
        name: 'GPT-5.6-Sol',
        group: 'gpt-budget',
        contextWindow: 372_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        sortOrder: 8,
      },
    ]);

    for (const agent of ['claude-code', 'codex'] as const) {
      const list = xdModels(agent);
      expect(list.map((m) => m.id)).toEqual(['gpt-5.6-sol']);
      expect(list[0]).toMatchObject({
        name: 'GPT-5.6-Sol',
        group: 'gpt-budget',
        contextWindow: 372_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
      });
    }
  });

  it('perAgent 覆盖块按 tab 应用(cc 无 Fast + 1M 窗口;codex 保持基线)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'gpt-5.5',
        agents: ['claude-code', 'codex'],
        name: 'GPT-5.5',
        contextWindow: 272_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'high',
        supportsFastMode: true,
        perAgent: { 'claude-code': { contextWindow: 1_000_000, supportsFastMode: false } },
      },
    ]);
    const cc = xdModels('claude-code')[0];
    const codex = xdModels('codex')[0];
    expect(cc).toMatchObject({ contextWindow: 1_000_000, supportsFastMode: false });
    expect(codex).toMatchObject({ contextWindow: 272_000, supportsFastMode: true });
    // 覆盖块没动的字段沿用基线。
    expect(cc.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('defaultEnabled 显式 false 透传;缺省不写键(= 默认可见)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      { id: 'hidden-model', defaultEnabled: false },
      { id: 'visible-model' },
    ]);
    const cc = xdModels('claude-code');
    expect(cc.find((m) => m.id === 'hidden-model')?.defaultEnabled).toBe(false);
    expect('defaultEnabled' in (cc.find((m) => m.id === 'visible-model') ?? {})).toBe(false);
  });

  it('icon(AI Gateway 展示图标设定)透传;缺省不写键(渲染层回落来源供应商标)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      { id: 'claude-fable-5', icon: 'claude' },
      { id: 'plain-model' },
    ]);
    const cc = xdModels('claude-code');
    expect(cc.find((m) => m.id === 'claude-fable-5')?.icon).toBe('claude');
    expect('icon' in (cc.find((m) => m.id === 'plain-model') ?? {})).toBe(false);
  });

  it('非法 effort 档位被白名单过滤;defaultEffort 不在档位集内时回落 high 规则', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      { id: 'weird-model', efforts: ['high', 'bogus-effort', 'max'], defaultEffort: 'bogus-effort' },
    ]);
    const cc = xdModels('claude-code');
    expect(cc[0].efforts).toEqual(['high', 'max']);
    expect(cc[0].defaultEffort).toBe('high');
  });

  it('其它供应商的模型列表逐字不变(同 id 模型经订阅直连仍可用)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const anthropicBefore = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    setXdGatewayModels([{ id: 'claude-opus-4-6' }]);
    const anthropicAfter = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    expect(anthropicAfter?.models).toEqual(anthropicBefore?.models);
  });

  it('清除实时清单后不回退任何静态模型', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ id: 'claude-opus-4-6' }]);
    expect(xdModels('claude-code')).toHaveLength(1);
    setXdGatewayModels([]);
    expect(xdModels('claude-code')).toEqual([]);
  });
});

describe('Anthropic 权威模型清单注入', () => {
  function anthropicModels() {
    const p = getActiveCatalog().providers.find((x) => x.id === 'anthropic');
    return p?.models['claude-code'] ?? [];
  }

  const opus: CatalogModel = {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    group: 'anthropic',
    sortOrder: 0,
    contextWindow: 1_000_000,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    supportsFastMode: true,
    status: 'active',
  };

  it('未注入时 anthropic 不暴露任何模型(不用静态数据冒充)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    expect(anthropicModels()).toEqual([]);
  });

  it('注入后整体重建 claude-code 清单;清空后回到空', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([opus]);
    expect(anthropicModels().map((m) => m.id)).toEqual(['claude-opus-4-8']);
    expect(anthropicModels()[0]).toMatchObject({ name: 'Opus 4.8', supportsFastMode: true });
    setAnthropicDiscoveredModels([]);
    expect(anthropicModels()).toEqual([]);
  });

  it('注入 anthropic 不影响其它供应商(xai 静态清单逐字不变)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const xaiBefore = getActiveCatalog().providers.find((p) => p.id === 'xai');
    setAnthropicDiscoveredModels([opus]);
    const xaiAfter = getActiveCatalog().providers.find((p) => p.id === 'xai');
    expect(xaiAfter?.models).toEqual(xaiBefore?.models);
  });
});
