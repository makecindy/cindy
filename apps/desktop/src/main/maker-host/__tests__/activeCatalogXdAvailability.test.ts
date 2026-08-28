/**
 * active-catalog XD 网关权威模型清单重建单测(2026-07-19 统一重构后语义)。
 * 不变量:
 *   - 空列表 = 不展示任何 XD 模型;清除后不回退任何静态数据;
 *   - 元数据只信服务端下发(不再回落产品目录条目):
 *       efforts 缺失 / 显式 [] → 不可调，defaultEffort 不猜 high;
 *       supportsFastMode / defaultEnabled 缺失保持缺失;
 *   - perAgent 覆盖块按 tab 应用(gpt 系 cc/codex 的 Fast / 窗口分叉);
 *   - tab 归属:服务端 agents > 仅 claude-code;
 *   - 其它供应商永不受影响。
 * 另含 anthropic 权威清单 setter 的同款语义单测。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, type CatalogModel } from '@cindy/model-providers';

import {
  getActiveCatalog,
  getXdGatewayModels,
  isXdGatewayPaymentRequiredRoute,
  resolveXdPiGatewayWireProtocol,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
  setXdGatewayModels,
} from '../active-catalog.js';
import { deriveAvailableModels } from '../catalog-to-descriptors.js';

function xdModels(agent: 'claude-code' | 'codex' | 'pi') {
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
    const xd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(xd?.imageModels).toEqual([]);
    expect(xd?.videoModels).toEqual([]);
  });

  it('显式空列表保持 XD 模型不可用', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([]);
    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex')).toEqual([]);
  });

  it('刷新失败可隐藏付费行，但派发边界保留最近一次明确拒绝直到成功响应', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'paid-only-model',
        agents: ['claude-code'],
        availability: 'requires_payment',
      },
    ]);
    expect(isXdGatewayPaymentRequiredRoute('paid-only-model', 'claude-code')).toBe(true);

    setXdGatewayModels([], {
      authoritative: false,
      preservePaymentRequiredRoutes: true,
    });
    expect(getXdGatewayModels()).toEqual([]);
    expect(isXdGatewayPaymentRequiredRoute('paid-only-model', 'claude-code')).toBe(true);

    setXdGatewayModels([
      {
        id: 'paid-only-model',
        agents: ['claude-code'],
        availability: 'available',
      },
    ], { authoritative: true });
    expect(isXdGatewayPaymentRequiredRoute('paid-only-model', 'claude-code')).toBe(false);
  });

  it('/models 同时控制 XD chat 与媒体成员，忽略 Catalog 里的旧媒体清单', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    const catalogXd = catalog.providers.find((provider) => provider.id === 'xd');
    if (!catalogXd) throw new Error('missing XD provider fixture');
    catalogXd.name = 'Catalog-supplied XD';
    catalogXd.imageModels = [];
    delete catalogXd.imageDefaults;
    catalogXd.embeddingModels = [];
    delete catalogXd.embeddingDefaults;
    catalogXd.videoModels = [{ id: 'seedance-fast', name: 'Seedance Fast' }];
    catalogXd.videoDefaults = { standard: 'seedance-fast' };
    catalogXd.models['claude-code'] = [
      {
        id: 'catalog-only-model',
        name: 'Catalog-only model',
        contextWindow: 1,
        efforts: [],
        defaultEffort: null,
      },
    ];

    setActiveCatalog(catalog);
    setXdGatewayModels([
      {
        id: 'openai/gpt-image-2',
        name: 'GPT Image 2',
        mode: 'image_generation',
        agents: [],
        modalities: { input: ['text', 'image'], output: ['image'] },
      },
      {
        id: 'bytedance/seedance-2.5',
        name: 'Seedance 2.5',
        mode: 'video_generation',
        agents: [],
        modalities: { input: ['text', 'image'], output: ['video'] },
      },
    ]);

    const activeXd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(activeXd?.name).toBe('Catalog-supplied XD');
    expect(activeXd?.imageModels).toEqual([
      {
        id: 'openai/gpt-image-2',
        name: 'GPT Image 2',
        modalities: { input: ['text', 'image'], output: ['image'] },
      },
    ]);
    expect(activeXd?.imageDefaults).toEqual({ standard: 'openai/gpt-image-2' });
    expect(activeXd?.embeddingModels).toEqual([]);
    expect(activeXd?.videoModels).toEqual([
      {
        id: 'bytedance/seedance-2.5',
        name: 'Seedance 2.5',
        modalities: { input: ['text', 'image'], output: ['video'] },
      },
    ]);
    expect(activeXd?.videoDefaults).toEqual({ standard: 'bytedance/seedance-2.5' });
    expect(xdModels('claude-code')).toEqual([]);
  });

  it('v3 未声明 agents 的模型不进入任何 runtime', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ id: 'brand-new-model' }]);
    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex')).toEqual([]);
    expect(xdModels('pi')).toEqual([]);
  });

  it('服务端显式声明 Codex Responses 路由及其能力覆写', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{
      id: 'fast-claude-only',
      agents: ['claude-code', 'codex'],
      supportsFastMode: true,
      perAgent: {
        codex: { supportsFastMode: false, wireProtocol: 'openai-responses' },
      },
    }]);
    expect(xdModels('claude-code')[0]?.supportsFastMode).toBe(true);
    expect(xdModels('codex')[0]).toMatchObject({
      supportsFastMode: false,
    });
  });

  it('Pi 在 cindy provider 内接受 v3 显式协议，并过滤缺失协议的模型', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'messages-model',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'anthropic-messages' } },
      },
      {
        id: 'responses-model',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
      {
        id: 'missing-wire',
        agents: ['claude-code', 'codex', 'pi'],
      },
      {
        id: 'claude-only-model',
        agents: ['claude-code'],
        perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' } },
      },
    ]);

    expect(resolveXdPiGatewayWireProtocol('messages-model')).toBe('anthropic-messages');
    expect(resolveXdPiGatewayWireProtocol('responses-model')).toBe('openai-responses');
    expect(resolveXdPiGatewayWireProtocol('responses-model[1m]')).toBe('openai-responses');
    expect(resolveXdPiGatewayWireProtocol('missing-wire')).toBeNull();
    expect(resolveXdPiGatewayWireProtocol('claude-only-model')).toBeUndefined();
    expect(resolveXdPiGatewayWireProtocol('unknown-model')).toBeUndefined();
    expect(xdModels('pi').map((model) => model.id)).toEqual([
      'messages-model',
      'responses-model',
    ]);
    expect(xdModels('pi')).toMatchObject([
      { id: 'messages-model', piApi: 'anthropic-messages' },
      { id: 'responses-model', piApi: 'openai-responses' },
    ]);
  });

  it('显式登记 efforts=[] 表示不可调,不合成 3 档;fast 显式 false 尊重', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'claude-haiku-4-5',
        agents: ['claude-code'],
        name: 'Haiku 4.5',
        efforts: [],
        supportsFastMode: false,
      },
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
    expect('codexCompatibilityWireProtocol' in xdModels('codex')[0]).toBe(false);
  });

  it('仅 codex 的模型不投影到 Claude tab', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'codex-native-only',
        agents: ['codex'],
        name: 'Codex Native Only',
      },
    ]);

    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex').map((model) => model.id)).toEqual(['codex-native-only']);
  });

  it('媒体 mode 条目不进入聊天目录，并保留在原始 Gateway 快照', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'image-without-guide',
        mode: 'image_generation',
        agents: [],
        name: 'Image Without Guide',
      },
      {
        id: 'video-model',
        mode: 'video_generation',
        agents: [],
        name: 'Video Model',
      },
      {
        id: 'chat-model',
        mode: 'chat',
        agents: ['codex'],
      },
    ]);

    expect(getXdGatewayModels().map((model) => model.id)).toEqual([
      'image-without-guide',
      'video-model',
      'chat-model',
    ]);
    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex').map((model) => model.id)).toEqual(['chat-model']);
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
      { id: 'hidden-model', agents: ['claude-code'], defaultEnabled: false },
      { id: 'visible-model', agents: ['claude-code'] },
    ]);
    const cc = xdModels('claude-code');
    expect(cc.find((m) => m.id === 'hidden-model')?.defaultEnabled).toBe(false);
    expect('defaultEnabled' in (cc.find((m) => m.id === 'visible-model') ?? {})).toBe(false);
  });

  it('icon(AI Gateway 展示图标设定)透传;缺省不写键(渲染层回落来源供应商标)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      { id: 'claude-fable-5', agents: ['claude-code'], icon: 'claude' },
      { id: 'plain-model', agents: ['claude-code'] },
    ]);
    const cc = xdModels('claude-code');
    expect(cc.find((m) => m.id === 'claude-fable-5')?.icon).toBe('claude');
    expect('icon' in (cc.find((m) => m.id === 'plain-model') ?? {})).toBe(false);
  });

  it('把网关图片输入 modalities 投影到 Pi 的 provider-model 能力', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'gateway-vision',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      {
        id: 'gateway-text',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
        modalities: { input: ['text'], output: ['text'] },
      },
      {
        id: 'gateway-unknown',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
    ]);

    const pi = deriveAvailableModels(getActiveCatalog(), 'pi');
    expect(pi.find((model) => model.id === 'gateway-vision')).toMatchObject({
      supportsImageInput: true,
    });
    expect(pi.find((model) => model.id === 'gateway-text')).toMatchObject({
      supportsImageInput: false,
    });
    expect(pi.find((model) => model.id === 'gateway-unknown')).not.toHaveProperty(
      'supportsImageInput',
    );
  });

  it('把标准 token 价投影为每百万 token 的折后展示价', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'half-price',
        agents: ['claude-code'],
        costDiscount: 0.5,
        inputCostPerToken: 0.000012,
        outputCostPerToken: 0.000036,
      },
      {
        id: 'twenty-percent-off',
        agents: ['claude-code'],
        costDiscount: 0.2,
        inputCostPerToken: 0.00001,
        outputCostPerToken: 0.00002,
      },
      {
        id: 'free-model',
        agents: ['claude-code'],
        inputCostPerToken: 0,
        outputCostPerToken: 0,
      },
      {
        id: 'full-price',
        agents: ['claude-code'],
        inputCostPerToken: 0.000012,
        outputCostPerToken: 0.000036,
      },
      {
        id: 'invalid-discount',
        agents: ['claude-code'],
        costDiscount: 1.2,
        inputCostPerToken: 0.000012,
        outputCostPerToken: 0.000036,
      },
      {
        id: 'missing-output',
        agents: ['claude-code'],
        inputCostPerToken: 0.000012,
      },
    ]);

    const cc = xdModels('claude-code');
    expect(cc.find((m) => m.id === 'half-price')?.cost).toEqual({
      input: 6,
      output: 18,
    });
    expect(cc.find((m) => m.id === 'twenty-percent-off')?.cost).toEqual({
      input: 8,
      output: 16,
    });
    expect(cc.find((m) => m.id === 'free-model')?.cost).toEqual({
      input: 0,
      output: 0,
    });
    expect(cc.find((m) => m.id === 'full-price')?.cost).toEqual({
      input: 12,
      output: 36,
    });
    expect(cc.find((m) => m.id === 'invalid-discount')?.cost).toEqual({
      input: 12,
      output: 36,
    });
    expect(cc.find((m) => m.id === 'missing-output')?.cost).toBeUndefined();
  });

  it('efforts 缺失时不合成档位，也不猜默认档', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'fixed-effort-model',
        agents: ['claude-code'],
      },
    ]);
    const cc = xdModels('claude-code');
    expect(cc[0].efforts).toEqual([]);
    expect(cc[0].defaultEffort).toBeNull();
  });

  it('其它供应商的模型列表逐字不变(同 id 模型经订阅直连仍可用)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const anthropicBefore = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    setXdGatewayModels([{ id: 'claude-opus-4-6', agents: ['claude-code'] }]);
    const anthropicAfter = getActiveCatalog().providers.find((p) => p.id === 'anthropic');
    expect(anthropicAfter?.models).toEqual(anthropicBefore?.models);
  });

  it('清除实时清单后不回退任何静态模型', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{ id: 'claude-opus-4-6', agents: ['claude-code'] }]);
    expect(xdModels('claude-code')).toHaveLength(1);
    setXdGatewayModels([]);
    expect(xdModels('claude-code')).toEqual([]);
  });
});

describe('Anthropic 权威模型清单注入', () => {
  function anthropicModels(agent: 'claude-code' | 'codex' = 'claude-code') {
    const p = getActiveCatalog().providers.find((x) => x.id === 'anthropic');
    return p?.models[agent] ?? [];
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

  /** registry-free 基线:本组验 discovery 注入机制;registry 实体化层见 modelPlane.test.ts。 */
  function bundledWithoutRegistry() {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    delete (catalog as { modelRegistry?: unknown }).modelRegistry;
    return catalog;
  }

  it('未注入且无 registry 时 anthropic 不暴露任何模型(不用静态数据冒充)', () => {
    setActiveCatalog(bundledWithoutRegistry());
    expect(anthropicModels()).toEqual([]);
  });

  it('注入后整体重建 claude-code 清单;清空后回到空', () => {
    setActiveCatalog(bundledWithoutRegistry());
    setAnthropicDiscoveredModels([opus]);
    expect(anthropicModels().map((m) => m.id)).toEqual(['claude-opus-4-8']);
    expect(anthropicModels()[0]).toMatchObject({ name: 'Opus 4.8', supportsFastMode: true });
    expect(anthropicModels('codex')[0]).toMatchObject({
      name: 'Opus 4.8',
      supportsFastMode: false,
    });
    setAnthropicDiscoveredModels([]);
    expect(anthropicModels()).toEqual([]);
    expect(anthropicModels('codex')).toEqual([]);
  });

  it('注入 anthropic 不影响其它供应商(xai 静态清单逐字不变)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const xaiBefore = getActiveCatalog().providers.find((p) => p.id === 'xai');
    setAnthropicDiscoveredModels([opus]);
    const xaiAfter = getActiveCatalog().providers.find((p) => p.id === 'xai');
    expect(xaiAfter?.models).toEqual(xaiBefore?.models);
  });
});
