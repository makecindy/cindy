/**
 * active-catalog XD 网关权威模型清单重建单测(2026-07-19 统一重构后语义)。
 * 不变量:
 *   - 空列表 = 不展示任何 XD 模型;清除后不回退任何静态数据;
 *   - 成员、通道能力只信服务端下发；默认深度优先 Cindy Registry:
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
  resolveXdPiGatewayApi,
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
  it('defaults every maintained GPT route to 272K while retaining capacity and smaller/non-GPT windows', () => {
    const ids = [
      'codex/gpt-6-astra', 'openai/gpt-6-astra',
      'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra', 'codex/gpt-5.6-luna',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'codex/gpt-5.5', 'codex/gpt-5.5:auto', 'gpt-5.5',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'codex/gpt-5.4-mini',
    ];
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      ...ids.map(id => ({ id, name: id, agents: ['claude-code', 'codex', 'pi'] as const,
        contextWindow: 1_050_000 })),
      { id: 'gpt-4-small', agents: ['codex'] as const, contextWindow: 128_000 },
      { id: 'z-ai/glm-5.3-flash', agents: ['codex'] as const, contextWindow: 1_000_000 },
    ].map(m => ({ ...m, agents: [...m.agents] })));
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      for (const id of ids) expect(xdModels(agent).find(m => m.id === id)).toMatchObject({
        contextWindow: 272_000, contextWindowMax: 1_050_000,
      });
    }
    expect(xdModels('codex').find(m => m.id === 'gpt-4-small')?.contextWindow).toBe(128_000);
    expect(xdModels('codex').find(m => m.id === 'z-ai/glm-5.3-flash')?.contextWindow).toBe(1_000_000);
  });

  it('未拉到实时清单时不暴露任何 XD 模型', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    expect(xdModels('claude-code')).toEqual([]);
    expect(xdModels('codex')).toEqual([]);
    const xd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(xd?.imageModels).toEqual([]);
    expect(xd?.videoModels).toEqual([]);
    expect(xd?.embeddingModels).toEqual(
      BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xd')?.embeddingModels,
    );
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

    setXdGatewayModels(
      [
        {
          id: 'paid-only-model',
          agents: ['claude-code'],
          availability: 'available',
        },
      ],
      { authoritative: true },
    );
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
      {
        id: 'voyage/voyage-4',
        name: 'Voyage 4',
        mode: 'embedding',
        availability: 'available',
        agents: [],
      },
      {
        id: 'voyage/voyage-4-large',
        name: 'Voyage 4 Large',
        mode: 'embedding',
        availability: 'requires_payment',
        agents: [],
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
    expect(activeXd?.embeddingModels).toEqual([{ id: 'voyage/voyage-4', name: 'Voyage 4' }]);
    expect(activeXd?.embeddingDefaults).toEqual({ standard: 'voyage/voyage-4' });
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

  it('网关明确返回仅付费 embedding 时不保留静态 embedding', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    const catalogXd = catalog.providers.find((provider) => provider.id === 'xd');
    if (!catalogXd) throw new Error('missing XD provider fixture');
    catalogXd.embeddingModels = [{ id: 'voyage/voyage-4', name: 'Voyage 4' }];
    catalogXd.embeddingDefaults = { standard: 'voyage/voyage-4' };

    setActiveCatalog(catalog);
    setXdGatewayModels(
      [
        {
          id: 'voyage/voyage-4',
          name: 'Voyage 4',
          mode: 'embedding',
          availability: 'requires_payment',
          agents: [],
        },
      ],
      { authoritative: true },
    );

    const activeXd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(activeXd?.embeddingModels).toBeUndefined();
    expect(activeXd?.embeddingDefaults).toBeUndefined();

    setXdGatewayModels([], {
      authoritative: false,
      preservePaymentRequiredRoutes: true,
    });

    const afterRefreshFailure = getActiveCatalog().providers.find(
      (provider) => provider.id === 'xd',
    );
    expect(afterRefreshFailure?.embeddingModels).toBeUndefined();
    expect(afterRefreshFailure?.embeddingDefaults).toBeUndefined();
  });

  it('网关 embedding 缺少 availability 时不解锁静态 embedding', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    const catalogXd = catalog.providers.find((provider) => provider.id === 'xd');
    if (!catalogXd) throw new Error('missing XD provider fixture');
    catalogXd.embeddingModels = [{ id: 'voyage/voyage-4', name: 'Voyage 4' }];
    catalogXd.embeddingDefaults = { standard: 'voyage/voyage-4' };

    setActiveCatalog(catalog);
    setXdGatewayModels([
      {
        id: 'voyage/voyage-4',
        name: 'Voyage 4',
        mode: 'embedding',
        agents: [],
      },
    ]);

    const activeXd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(activeXd?.embeddingModels).toBeUndefined();
    expect(activeXd?.embeddingDefaults).toBeUndefined();
  });

  it('网关权威空快照清除静态 embedding', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    const catalogXd = catalog.providers.find((provider) => provider.id === 'xd');
    if (!catalogXd) throw new Error('missing XD provider fixture');
    catalogXd.embeddingModels = [{ id: 'voyage/voyage-4', name: 'Voyage 4' }];
    catalogXd.embeddingDefaults = { standard: 'voyage/voyage-4' };

    setActiveCatalog(catalog);
    setXdGatewayModels([], { authoritative: true });

    const activeXd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(activeXd?.embeddingModels).toBeUndefined();
    expect(activeXd?.embeddingDefaults).toBeUndefined();
  });

  it('账号边界等待新快照时不回退到静态 embedding', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    const catalogXd = catalog.providers.find((provider) => provider.id === 'xd');
    if (!catalogXd) throw new Error('missing XD provider fixture');
    catalogXd.embeddingModels = [{ id: 'voyage/voyage-4', name: 'Voyage 4' }];
    catalogXd.embeddingDefaults = { standard: 'voyage/voyage-4' };

    setActiveCatalog(catalog);
    setXdGatewayModels([], { suppressEmbeddingFallback: true });

    const activeXd = getActiveCatalog().providers.find((provider) => provider.id === 'xd');
    expect(activeXd?.embeddingModels).toBeUndefined();
    expect(activeXd?.embeddingDefaults).toBeUndefined();
  });

  it('uses the model default for every Gateway harness and only adapts unsupported levels', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{
      id: 'future-reasoner', agents: ['claude-code', 'codex', 'pi'],
      efforts: ['low', 'medium', 'high'], defaultEffort: 'high',
      perAgent: {
        codex: { defaultEffort: 'high' },
        pi: { defaultEffort: 'low' },
        'claude-code': { efforts: ['low'], defaultEffort: 'low' },
      },
    }]);
    expect(xdModels('codex')[0]?.defaultEffort).toBe('medium');
    expect(xdModels('pi')[0]?.defaultEffort).toBe('medium');
    expect(xdModels('claude-code')[0]?.defaultEffort).toBe('low');
  });

  it.each([
    ['moonshotai/kimi-k3', 'max'],
    ['bytedance-seed/seed-2.1-pro', 'minimal'],
    ['qwen/qwen3.8-max', 'xhigh'],
    ['z-ai/glm-5.3-flash', 'max'],
    ['deepseek/deepseek-v4-flash-vision-exp', 'high'],
    ['tencent/hy4-preview', 'high'],
  ] as const)('常用模型 %s 的三个 Harness 都采用 Cindy 默认中，保留 Gateway 的窗口和能力', (id, oldDefault) => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([{
      id, name: id, agents: ['claude-code', 'codex', 'pi'],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: oldDefault, contextWindow: 987654,
      perAgent: { pi: { defaultEffort: 'max' } },
    }]);
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      expect(xdModels(agent)[0]).toMatchObject({ defaultEffort: 'medium', contextWindow: 987654 });
    }
  });

  it('新的 Server Registry 可更新默认；实际不支持的档位只适配，不增加能力', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const entry = catalog.modelRegistry!.models.find(m => m.id === 'xd/z-ai-glm-5.3-flash')!;
    entry.defaultEffort = 'high';
    setActiveCatalog(catalog);
    setXdGatewayModels([{
      id: 'z-ai/glm-5.3-flash', agents: ['claude-code', 'codex', 'pi'],
      efforts: ['low', 'medium', 'high'], defaultEffort: 'max',
      perAgent: { 'claude-code': { efforts: ['low'] }, codex: { efforts: [] } },
    }]);
    expect(xdModels('pi')[0]?.defaultEffort).toBe('high');
    expect(xdModels('claude-code')[0]).toMatchObject({ efforts: ['low'], defaultEffort: 'low' });
    expect(xdModels('codex')[0]).toMatchObject({ efforts: [], defaultEffort: null });
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
    setXdGatewayModels([
      {
        id: 'fast-claude-only',
        agents: ['claude-code', 'codex'],
        supportsFastMode: true,
        perAgent: {
          codex: { supportsFastMode: false, wireProtocol: 'openai-responses' },
        },
      },
    ]);
    expect(xdModels('claude-code')[0]?.supportsFastMode).toBe(true);
    expect(xdModels('codex')[0]).toMatchObject({
      supportsFastMode: false,
    });
  });

  it('按 Cindy Server > 本地 Pi 表 > Cindy AI Gateway 的顺序解析 API', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    catalog.presets = [
      ...(catalog.presets ?? []),
      {
        id: 'server-moonshot-test',
        name: 'Server Moonshot Test',
        runtimes: {
          pi: {
            baseUrl: 'https://server.example/anthropic',
            wireProtocol: 'anthropic-messages',
            models: [{ id: 'kimi-k3', name: 'Kimi K3' }],
          },
        },
      },
    ];
    const registryEntry = catalog.modelRegistry?.models.find(
      (entry) =>
        entry.id === 'moonshotai/kimi-k3' ||
        entry.routes.some(
          (route) => route.providerId === 'xd' && route.modelId === 'moonshot/kimi-k3',
        ),
    );
    if (!registryEntry) throw new Error('missing Kimi registry fixture');
    registryEntry.nativeApi = 'anthropic-messages';
    registryEntry.routes = [
      { providerId: 'xd', modelId: 'moonshot/kimi-k3', agents: ['claude-code', 'codex'] },
      {
        providerId: 'server-moonshot-test',
        modelId: 'kimi-k3',
        agents: ['claude-code', 'codex'],
      },
    ];
    setActiveCatalog(catalog, { authorityCatalog: catalog });
    setXdGatewayModels([
      {
        id: 'moonshot/kimi-k3',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
      {
        id: 'claude-opus-5',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
      {
        id: 'gpt-5.6-sol',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'anthropic-messages' } },
      },
      {
        id: 'google/gemini-3.7-flash',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
      {
        id: 'future-unmapped-model',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
      {
        id: 'future-unsupported-api',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'future-protocol' as never } },
      },
      {
        id: 'gemini-3.6-flash',
        agents: ['codex'],
        perAgent: { codex: { wireProtocol: 'openai-responses' } },
      },
    ]);

    // Cindy Server beats both local Kimi Completions metadata and Gateway Responses.
    expect(resolveXdPiGatewayApi('moonshot/kimi-k3')).toBe('anthropic-messages');
    expect(resolveXdPiGatewayWireProtocol('moonshot/kimi-k3')).toBe('anthropic-messages');
    // With no server declaration, the version-matched local table beats Gateway hints.
    expect(resolveXdPiGatewayApi('claude-opus-5')).toBe('anthropic-messages');
    expect(resolveXdPiGatewayApi('gpt-5.6-sol')).toBe('openai-responses');
    expect(resolveXdPiGatewayApi('google/gemini-3.7-flash')).toBe('google-generative-ai');
    expect(resolveXdPiGatewayWireProtocol('google/gemini-3.7-flash')).toBeNull();
    // Gateway is consulted only when both higher-priority sources are absent.
    expect(resolveXdPiGatewayApi('future-unmapped-model')).toBe('openai-responses');
    expect(resolveXdPiGatewayApi('future-unsupported-api')).toBeNull();
    expect(resolveXdPiGatewayApi('gemini-3.6-flash')).toBeUndefined();
    expect(xdModels('pi')).toMatchObject([
      { id: 'moonshot/kimi-k3', piApi: 'anthropic-messages' },
      { id: 'claude-opus-5', piApi: 'anthropic-messages' },
      { id: 'gpt-5.6-sol', piApi: 'openai-responses' },
      { id: 'google/gemini-3.7-flash', piApi: 'google-generative-ai' },
      { id: 'future-unmapped-model', piApi: 'openai-responses' },
      { id: 'future-unsupported-api' },
    ]);
  });

  it('Cindy Server 的精确 retired tombstone 会隐藏滞后的 Gateway Pi 成员', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as typeof BUNDLED_CATALOG;
    catalog.modelRegistry = {
      schemaVersion: 2,
      updatedAt: '2026-08-29T00:00:00.000Z',
      models: [
        {
          id: 'canonical/kimi-k3',
          name: 'Kimi K3',
          status: 'retired',
          routes: [
            { providerId: 'xd', modelId: 'moonshot/kimi-k3', agents: ['claude-code', 'codex'] },
          ],
        },
      ],
    };
    setActiveCatalog(catalog, { authorityCatalog: catalog });
    setXdGatewayModels([
      {
        id: 'moonshot/kimi-k3',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
    ]);

    expect(resolveXdPiGatewayApi('moonshot/kimi-k3')).toBeNull();
    expect(xdModels('pi')).toEqual([]);
    expect(xdModels('codex').map((model) => model.id)).toEqual(['moonshot/kimi-k3']);
  });

  it('Cindy AI Gateway 只决定账号成员，不会覆盖高优先级 API 或凭其它 agent 擅自投影', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'claude-opus-5',
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
      {
        id: 'google/gemini-3.6-flash',
        agents: ['codex'],
        perAgent: { codex: { wireProtocol: 'openai-responses' } },
      },
    ]);

    expect(resolveXdPiGatewayApi('claude-opus-5')).toBe('anthropic-messages');
    expect(resolveXdPiGatewayApi('google/gemini-3.6-flash')).toBeUndefined();
    expect(xdModels('pi')).toMatchObject([{ id: 'claude-opus-5', piApi: 'anthropic-messages' }]);
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

  it('服务端决定成员和能力，默认深度优先 Cindy Registry', () => {
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
        contextWindow: 272_000,
        contextWindowMax: 372_000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        defaultEffort: 'medium',
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

  it('perAgent Fast 差异保留，GPT 工作窗口采用保守默认', () => {
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
    expect(cc).toMatchObject({ contextWindow: 272_000, supportsFastMode: false });
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
        id: 'google/gemini-3.7-flash',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      {
        id: 'qwen/qwen3.8-27b',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
        modalities: { input: ['text'], output: ['text'] },
      },
      {
        id: 'qwen/qwen3.8-flash',
        agents: ['pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
    ]);

    const pi = deriveAvailableModels(getActiveCatalog(), 'pi');
    expect(pi.find((model) => model.id === 'google/gemini-3.7-flash')).toMatchObject({
      supportsImageInput: true,
    });
    expect(pi.find((model) => model.id === 'qwen/qwen3.8-27b')).toMatchObject({
      supportsImageInput: false,
    });
    expect(pi.find((model) => model.id === 'qwen/qwen3.8-flash')).not.toHaveProperty(
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

describe('gateway cross-harness defaults', () => {
  it('projects reviewed Gateway defaults through native harness policy and live capability changes', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const candidates = [
      ['deepseek/deepseek-v4-pro', ['text']],
      ['deepseek/deepseek-v4-flash', ['text']],
      ['deepseek/deepseek-v4-flash-vision-exp', ['text', 'image']],
      ['tencent/hy3', ['text']],
      ['tencent/hy4-preview', ['text']],
    ] as const;
    const live = candidates.map(([id, input]) => ({
      id, name: id, mode: 'chat', agents: ['claude-code', 'codex', 'pi'] as const,
      defaultEnabled: true, modalities: { input: [...input], output: ['text'] },
      perAgent: { pi: { wireProtocol: 'openai-responses' as const } },
    }));
    setXdGatewayModels(live.map(model => ({ ...model, agents: [...model.agents] })));
    const enabled = () => xdModels('pi').filter(model => model.defaultEnabled !== false).map(model => model.id);
    expect(enabled().sort()).toEqual(['deepseek/deepseek-v4-flash-vision-exp', 'tencent/hy4-preview']);
    for (const agent of ['claude-code', 'codex'] as const) {
      expect(xdModels(agent).every(model => model.defaultEnabled === false)).toBe(true);
    }
    expect(xdModels('pi').every(model => model.piApi === 'openai-completions')).toBe(true);
    setXdGatewayModels(live.map(model => ({ ...model, agents: [...model.agents], modalities: { input: ['text'], output: ['text'] } })));
    expect(enabled().sort()).toEqual(['deepseek/deepseek-v4-pro', 'tencent/hy4-preview']);
  });

  it.each([1, 2, 3] as const)(
    'retains local native APIs with a sparse Server V%s catalog and misleading Gateway hints',
    (schemaVersion) => {
      const next = structuredClone(BUNDLED_CATALOG);
      next.modelRegistry = { schemaVersion, updatedAt: '2099-02-01T00:00:00.000Z', models: [] };
      setActiveCatalog(next, { authorityCatalog: next });
      const examples = [
        ['google/gemini-3.8-flash', 'google-generative-ai'],
        ['bytedance-seed/seed-2.1-pro', 'openai-completions'],
        ['deepseek/deepseek-v4-flash-vision-exp', 'openai-completions'],
        ['qwen/qwen3.8-flash', 'openai-completions'],
        ['moonshotai/kimi-k3', 'openai-completions'],
        ['z-ai/glm-5.3-flash', 'openai-completions'],
        ['tencent/hy4-preview', 'openai-completions'],
        ['meta/muse-spark-1.3', 'openai-responses'],
        ['x-ai-grok/grok-4.6', 'openai-responses'],
        ['minimax/MiniMax-M3', 'anthropic-messages'],
        ['anthropic-claude/claude-fable-5-1', 'anthropic-messages'],
        ['codex/gpt-6-astra', 'openai-responses'],
      ] as const;
      setXdGatewayModels(
        examples.map(([id]) => ({
          id,
          name: id,
          agents: ['claude-code', 'codex', 'pi'],
          defaultEnabled: true,
          contextWindow: 123_456,
          perAgent: { pi: { wireProtocol: 'openai-responses' } },
        })),
      );
      for (const [id, api] of examples) {
        const everyday = !['deepseek/deepseek-v4-flash-vision-exp', 'tencent/hy4-preview'].includes(
          id,
        );
        const pi = xdModels('pi').find((m) => m.id === id)!;
        expect(pi).toMatchObject({
          nativeApi: api,
          piApi: api,
          defaultEnabled: everyday,
          contextWindow: 123_456,
        });
        expect(resolveXdPiGatewayApi(id)).toBe(api);
        expect(xdModels('claude-code').find((m) => m.id === id)).toMatchObject({
          nativeApi: api,
          defaultEnabled: everyday && api === 'anthropic-messages',
        });
        expect(xdModels('codex').find((m) => m.id === id)).toMatchObject({
          nativeApi: api,
          defaultEnabled: everyday && api === 'openai-responses',
        });
      }
      setXdGatewayModels([]);
      expect(xdModels('pi')).toEqual([]);
    },
  );

  it('uses canonical APIs for defaults and accepts a later server correction without editing Pi metadata', () => {
    const id = 'google/gemini-future';
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id,
        name: 'Future Gemini',
        contextWindow: 1_048_576,
        defaultEnabled: true,
        agents: ['claude-code', 'codex', 'pi'],
        perAgent: { pi: { wireProtocol: 'openai-responses' } },
      },
    ]);
    expect(xdModels('claude-code')[0]).toMatchObject({
      nativeApi: 'google-generative-ai',
      defaultEnabled: false,
    });
    expect(xdModels('codex')[0].defaultEnabled).toBe(false);
    expect(xdModels('pi')[0]).toMatchObject({
      piApi: 'google-generative-ai',
      defaultEnabled: true,
    });
    const next = structuredClone(BUNDLED_CATALOG);
    next.modelRegistry!.updatedAt = '2099-01-01T00:00:00.000Z';
    next.modelRegistry!.models.push({
      id: 'future/gemini',
      name: 'Future Gemini',
      nativeApi: 'openai-responses',
      routes: [{ providerId: 'xd', modelId: id, agents: ['claude-code', 'codex'] }],
    });
    setActiveCatalog(next, { authorityCatalog: next });
    expect(xdModels('codex')[0]).toMatchObject({
      nativeApi: 'openai-responses',
      defaultEnabled: true,
    });
    expect(xdModels('claude-code')[0].defaultEnabled).toBe(false);
    expect(xdModels('pi')[0].piApi).toBe('openai-responses');
    // Explicitly unverified native metadata does not disable a declared execution route.
    next.modelRegistry!.models.at(-1)!.nativeApi = null;
    setActiveCatalog(next, { authorityCatalog: next });
    expect(xdModels('pi')[0]).toMatchObject({ nativeApi: null, piApi: 'openai-responses' });
    // Omitting metadata in a later V3 catalog must not erase Cindy's local protocol knowledge.
    next.modelRegistry!.nativeApiRules = [];
    next.modelRegistry!.models = [];
    setActiveCatalog(next, { authorityCatalog: next });
    expect(xdModels('pi')[0].nativeApi).toBe('google-generative-ai');
    expect(xdModels('pi')[0].piApi).toBe('google-generative-ai');
  });

  it('prefers a usable route over a more discounted route with every harness disabled', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setXdGatewayModels([
      {
        id: 'openai/gpt-6-astra',
        name: 'Astra',
        agents: ['codex', 'pi'],
        contextWindow: 1_050_000,
        costDiscount: 0.4,
      },
      {
        id: 'codex/gpt-6-astra',
        name: 'Astra',
        agents: ['codex', 'pi'],
        contextWindow: 1_050_000,
        costDiscount: 0.85,
        perAgent: { codex: { defaultEnabled: false }, pi: { defaultEnabled: false } },
      },
    ]);
    expect(
      xdModels('codex').find((model) => model.id === 'openai/gpt-6-astra')?.defaultEnabled,
    ).not.toBe(false);
    expect(
      xdModels('codex').find((model) => model.id === 'codex/gpt-6-astra')?.defaultEnabled,
    ).toBe(false);
    expect(xdModels('codex')).toHaveLength(2);
  });

  it('applies per-agent policy to the selected models while keeping old generations opt-in', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    const entries = ['codex/gpt-6', 'claude-opus-5', 'anthropic-claude/claude-opus-4-8'].map(
      (id) => ({
        id,
        name: id,
        contextWindow: 1_000_000,
        defaultEnabled: true,
        agents: ['claude-code', 'codex', 'pi'] as const,
      }),
    );
    setXdGatewayModels(entries.map((e) => ({ ...e, agents: [...e.agents] })));
    expect(xdModels('claude-code').map((m) => m.defaultEnabled)).toEqual([false, true, false]);
    expect(xdModels('codex').map((m) => m.defaultEnabled)).toEqual([true, false, false]);
    expect(xdModels('pi').map((m) => m.defaultEnabled)).toEqual([true, true, false]);
    setXdGatewayModels(
      entries.map((e) => ({
        ...e,
        agents: [...e.agents],
        perAgent: { 'claude-code': { defaultEnabled: true }, codex: { defaultEnabled: true } },
      })),
    );
    expect(xdModels('claude-code').map((m) => m.defaultEnabled)).toEqual([true, true, false]);
    expect(xdModels('codex').map((m) => m.defaultEnabled)).toEqual([true, true, false]);
  });
});
