/**
 * catalog → availableModels 派生契约(2026-07-19 模型列表统一重构后)。
 *
 * 历史:本文件曾是「迁移前硬编码清单的逐字快照」守卫(规则 10 no-break)。统一重构后
 * 静态清单**按设计**退役——anthropic/openai/xd 的清单运行时动态注入(SDK 发现 /
 * codex 注册表 / 网关下发,见 active-catalog + model-discovery),bundled 只剩 xai。
 * 冻结快照随之退役;本守卫改为守派生机制本身的契约:
 *   1. bundled 派生 = 仅 xai 静态清单(动态供应商零静态模型,不用假数据冒充);
 *   2. 注入后的目录按 provider 序 flatMap + id 首见去重,per-agent 分叉字段透传;
 *   3. refreshCatalogDerivedModels 原地 splice(已建会话持引用可见新目录)。
 */

import { describe, it, expect } from 'vitest';

import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import type { Catalog, CatalogModel } from '@cindy/model-providers';
import type { ModelDescriptor } from '@cindy/maker-core';

import {
  deriveAvailableModels,
  refreshCatalogDerivedModels,
  resolvePiGatewayDescriptorProviderId,
  resolvePiRuntimeModelDescriptor,
  resolveVerifiedContextWindow,
} from '../catalog-to-descriptors.js';

function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null, ...extra };
}

/** 模拟 active-catalog 注入动态清单后的目录。 */
function injectedCatalog(): Catalog {
  const clone = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  for (const p of clone.providers) {
    if (p.id === 'anthropic') {
      p.models['claude-code'] = [
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', supportsFastMode: true, group: 'anthropic', sortOrder: 1 }),
      ];
    }
    if (p.id === 'openai') {
      p.models.codex = [
        model('gpt-5.5', { name: 'GPT-5.5', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFastMode: true, group: 'gpt', sortOrder: 20 }),
      ];
      p.models['claude-code'] = [
        model('chatgpt/gpt-5.5', { name: 'GPT-5.5', contextWindow: 272_000, group: 'gpt', sortOrder: 20 }),
      ];
    }
    if (p.id === 'xd') {
      p.models['claude-code'] = [
        // 同 id 跨 provider:anthropic first-wins,xd 的这条在派生时被去重掉。
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, supportsFastMode: false, group: 'anthropic', sortOrder: 1 }),
        // per-agent 分叉:同 id 在 cc=1M / codex=272k。
        model('gpt-5.5', { name: 'GPT-5.5', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', group: 'gpt', sortOrder: 20 }),
      ];
      p.models.codex = [
        model('gpt-5.5', { name: 'GPT-5.5', contextWindow: 272_000, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', group: 'gpt', sortOrder: 20 }),
      ];
    }
  }
  return clone;
}

describe('deriveAvailableModels — dynamic-first catalog contract', () => {
  it('adds native minimal thinking to reasoning-capable Pi models only', () => {
    const pi = deriveAvailableModels(BUNDLED_CATALOG, 'pi');
    expect(pi.find((m) => m.id === 'xai/grok-4.3')?.efforts[0]).toBe('minimal');
    expect(pi.find((m) => m.id === 'xai/grok-code-fast')?.efforts).toEqual([]);
  });

  it('preserves the explicit effort subset of a Pi BYOM model in remote capabilities', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.providers.push(
      buildUserProvider({
        id: 'explicit-reasoning',
        name: 'Explicit reasoning',
        auth: { method: 'none' },
        runtimes: {
          pi: {
            baseUrl: 'http://127.0.0.1:11434/v1',
            wireProtocol: 'openai-responses',
            models: [
              {
                id: 'reasoner',
                name: 'Reasoner',
                reasoning: true,
                reasoningEfforts: ['low', 'high'],
              },
            ],
          },
        },
      }),
    );

    expect(deriveAvailableModels(catalog, 'pi').find((m) => m.id === 'reasoner')).toMatchObject({
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    });
    expect(resolvePiRuntimeModelDescriptor(catalog, 'explicit-reasoning', 'reasoner')).toMatchObject({
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    });
  });

  it('intersects flat Pi efforts when a later BYOM provider reuses a built-in model id', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.providers.push(
      buildUserProvider({
        id: 'colliding-reasoning',
        name: 'Colliding reasoning',
        auth: { method: 'none' },
        runtimes: {
          pi: {
            baseUrl: 'http://127.0.0.1:11434/v1',
            wireProtocol: 'openai-responses',
            models: [
              {
                id: 'xai/grok-4.3',
                name: 'Grok 4.3 through BYOM',
                reasoning: true,
                reasoningEfforts: ['low'],
              },
              {
                id: 'xai/grok-4.5',
                name: 'Grok 4.5 without declared reasoning',
              },
            ],
          },
        },
      }),
    );

    const flatModels = deriveAvailableModels(catalog, 'pi');
    const flat = flatModels.filter((m) => m.id === 'xai/grok-4.3');
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({
      efforts: ['low'],
      defaultEffort: 'low',
    });
    expect(
      resolvePiRuntimeModelDescriptor(catalog, 'colliding-reasoning', 'xai/grok-4.3'),
    ).toMatchObject({
      efforts: ['low'],
      defaultEffort: 'low',
    });
    expect(flatModels.find((m) => m.id === 'xai/grok-4.5')).toMatchObject({
      efforts: [],
      defaultEffort: null,
    });
  });

  it('resolves the cindy gateway descriptor from built-ins when a non-reasoning BYOM claims the same id first', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.providers.unshift(
      buildUserProvider({
        id: 'colliding-non-reasoning',
        name: 'Colliding non-reasoning',
        auth: { method: 'none' },
        runtimes: {
          pi: {
            baseUrl: 'http://127.0.0.1:11434/v1',
            wireProtocol: 'openai-responses',
            models: [{ id: 'xai/grok-4.5', name: 'Grok 4.5 without reasoning' }],
          },
        },
      }),
    );

    expect(deriveAvailableModels(catalog, 'pi').find((m) => m.id === 'xai/grok-4.5')).toMatchObject({
      efforts: [],
      defaultEffort: null,
    });
    expect(
      resolvePiRuntimeModelDescriptor(catalog, 'colliding-non-reasoning', 'xai/grok-4.5'),
    ).toMatchObject({ efforts: [], defaultEffort: null });
    expect(resolvePiRuntimeModelDescriptor(catalog, 'cindy', 'xai/grok-4.5')).toMatchObject({
      efforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'high',
    });
  });

  it('resolves an explicit XD descriptor instead of a same-id subscription descriptor', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const openai = catalog.providers.find((provider) => provider.id === 'openai');
    const xd = catalog.providers.find((provider) => provider.id === 'xd');
    expect(openai).toBeDefined();
    expect(xd).toBeDefined();
    openai!.models.pi = [model('shared-default-route', {
      name: 'Subscription Shared',
      contextWindow: 128_000,
    })];
    xd!.models.pi = [model('shared-default-route', {
      name: 'XD Shared',
      contextWindow: 200_000,
    })];

    expect(resolvePiGatewayDescriptorProviderId(null)).toBe('xd');
    expect(resolvePiGatewayDescriptorProviderId('cindy')).toBe('xd');
    expect(resolvePiGatewayDescriptorProviderId('openai')).toBe('openai');
    expect(resolvePiRuntimeModelDescriptor(
      catalog,
      resolvePiGatewayDescriptorProviderId(null),
      'shared-default-route',
    )).toMatchObject({
      displayName: 'XD Shared',
      contextWindow: 200_000,
    });
  });

  it('projects explicit provider-model image modalities and leaves unknown capability unset', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const xd = catalog.providers.find((provider) => provider.id === 'xd');
    expect(xd).toBeDefined();
    xd!.models.pi = [
      model('gateway-vision', { modalities: { input: ['text', 'image'], output: ['text'] } }),
      model('gateway-text', { modalities: { input: ['text'], output: ['text'] } }),
      model('gateway-unknown'),
    ];

    expect(resolvePiRuntimeModelDescriptor(catalog, 'cindy', 'gateway-vision')).toMatchObject({
      supportsImageInput: true,
    });
    expect(resolvePiRuntimeModelDescriptor(catalog, 'cindy', 'gateway-text')).toMatchObject({
      supportsImageInput: false,
    });
    expect(resolvePiRuntimeModelDescriptor(catalog, 'cindy', 'gateway-unknown')).not.toHaveProperty(
      'supportsImageInput',
    );
  });

  it('bundled(未注入)派生 = 仅 xai 静态清单,动态供应商不贡献任何条目', () => {
    const cc = deriveAvailableModels(BUNDLED_CATALOG, 'claude-code');
    const codex = deriveAvailableModels(BUNDLED_CATALOG, 'codex');
    expect(cc.map((m) => m.id)).toEqual([
      'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-build-0.1',
      'xai/grok-4.20-multi-agent-0309', 'xai/grok-4.20-0309-reasoning',
      'xai/grok-4.20-0309-non-reasoning', 'xai/grok-4.20', 'xai/grok-code-fast',
    ]);
    expect(codex.map((m) => m.id)).toEqual([
      'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-build-0.1',
      'xai/grok-4.20-multi-agent-0309', 'xai/grok-4.20-0309-reasoning',
      'xai/grok-4.20-0309-non-reasoning', 'xai/grok-4.20', 'xai/grok-code-fast',
    ]);
  });

  it('xai 静态条目字段透传(窗口 / effort / 分组)', () => {
    const codex = deriveAvailableModels(BUNDLED_CATALOG, 'codex');
    expect(codex.find((m) => m.id === 'xai/grok-4.3')).toMatchObject({
      displayName: 'Grok 4.3',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      group: 'grok',
    });
    expect(codex.find((m) => m.id === 'xai/grok-code-fast')).toMatchObject({
      efforts: [],
      defaultEffort: null,
    });
  });

  // availableModels 是跨 provider 去重后的扁平表 —— provenance 刻意**不**进这份 descriptor:
  // 归属已丢,按 id 回查可能命中另一条路由。收敛改走 resolveVerifiedContextWindow。
  it('toDescriptor 不透传 contextWindowVerified(provenance 只留在 host 侧)', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    for (const p of catalog.providers) {
      if (p.id !== 'openai') continue;
      p.models.codex = [model('verified/known', { contextWindow: 372_000, contextWindowVerified: true })];
    }
    const d = deriveAvailableModels(catalog, 'codex').find((m) => m.id === 'verified/known');
    expect(d?.contextWindow).toBe(372_000);
    expect(d && 'contextWindowVerified' in d).toBe(false);
  });

  it('注入后:按 provider 序 union + id 首见去重(anthropic 先于 xd,fast 分叉取首见)', () => {
    const cc = deriveAvailableModels(injectedCatalog(), 'claude-code');
    const ids = cc.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    // provider 序:anthropic → openai → xai → xd。
    expect(ids).toEqual([
      'claude-opus-4-8',
      'chatgpt/gpt-5.5',
      'xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-build-0.1',
      'xai/grok-4.20-multi-agent-0309', 'xai/grok-4.20-0309-reasoning',
      'xai/grok-4.20-0309-non-reasoning', 'xai/grok-4.20', 'xai/grok-code-fast',
      'gpt-5.5',
    ]);
    // 首见胜出:opus 取 anthropic 条目(supportsFastMode=true),不是 xd 的 false。
    expect(cc.find((m) => m.id === 'claude-opus-4-8')?.supportsFastMode).toBe(true);
  });

  it('同 id 首见胜出时仍合并 XD 对当前 agent 的区域默认标记', () => {
    const catalog = injectedCatalog();
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')!;
    const xd = catalog.providers.find((provider) => provider.id === 'xd')!;

    xd.models['claude-code'] = (xd.models['claude-code'] ?? []).map((entry) =>
      entry.id === 'claude-opus-4-8'
        ? { ...entry, newSessionDefault: ['claude-code', 'codex'] }
        : entry,
    );
    xd.models.codex = (xd.models.codex ?? []).map((entry) =>
      entry.id === 'gpt-5.5'
        ? { ...entry, newSessionDefault: ['claude-code', 'codex'] }
        : entry,
    );
    anthropic.models.pi = [model('shared-default')];
    xd.models.pi = [
      model('shared-default', { newSessionDefault: ['pi'] }),
    ];

    expect(
      deriveAvailableModels(catalog, 'claude-code').find(
        (entry) => entry.id === 'claude-opus-4-8',
      ),
    ).toMatchObject({ supportsFastMode: true, newSessionDefault: ['claude-code'] });
    expect(
      deriveAvailableModels(catalog, 'codex').find((entry) => entry.id === 'gpt-5.5'),
    ).toMatchObject({ contextWindow: 272_000, newSessionDefault: ['codex'] });
    expect(
      deriveAvailableModels(catalog, 'pi').find((entry) => entry.id === 'shared-default'),
    ).toMatchObject({ newSessionDefault: ['pi'] });
  });

  it('per-agent 分叉透传:gpt-5.5 cc=1M / codex=272k', () => {
    const cat = injectedCatalog();
    expect(deriveAvailableModels(cat, 'claude-code').find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(1_000_000);
    expect(deriveAvailableModels(cat, 'codex').find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(272_000);
  });

  it('跳过 routing.disabled runtime，且不占用同模型的 first-wins', () => {
    const cat = injectedCatalog();
    const openai = cat.providers.find((provider) => provider.id === 'openai')!;
    const xd = cat.providers.find((provider) => provider.id === 'xd')!;
    const openaiCodexRoute = openai.routing.codex;
    if (!openaiCodexRoute) throw new Error('OpenAI Codex route fixture missing');
    openai.routing.codex = {
      ...openaiCodexRoute,
      disabled: true,
    };
    openai.models.codex = [
      model('disabled-only', { name: 'Disabled only' }),
      model('gpt-5.5', { name: 'Disabled first', contextWindow: 111 }),
    ];
    xd.models.codex = [
      model('gpt-5.5', { name: 'Enabled later', contextWindow: 222 }),
    ];

    const derived = deriveAvailableModels(cat, 'codex');
    expect(derived.some((candidate) => candidate.id === 'disabled-only')).toBe(false);
    expect(derived.find((candidate) => candidate.id === 'gpt-5.5')).toMatchObject({
      displayName: 'Enabled later',
      contextWindow: 222,
    });
  });

  it('非聊天模型(issue #882 第 3 点)不进任一 agent 的 availableModels,但仍留在完整 catalog 里', () => {
    const cat = injectedCatalog();
    const xd = cat.providers.find((provider) => provider.id === 'xd')!;
    xd.models['claude-code'] = [
      ...(xd.models['claude-code'] ?? []),
      model('gpt-image-2', { name: 'GPT Image 2', mode: 'image_generation', group: undefined }),
      model('text-embedding-3-large', { name: 'Embedding 3 Large' }), // 无 mode,靠 id 正则兜底判定为 embedding
    ];
    xd.models.codex = [
      ...(xd.models.codex ?? []),
      model('gpt-image-2', { name: 'GPT Image 2', mode: 'image_generation' }),
    ];

    const cc = deriveAvailableModels(cat, 'claude-code');
    const codex = deriveAvailableModels(cat, 'codex');
    expect(cc.some((m) => m.id === 'gpt-image-2')).toBe(false);
    expect(cc.some((m) => m.id === 'text-embedding-3-large')).toBe(false);
    expect(codex.some((m) => m.id === 'gpt-image-2')).toBe(false);
    // 完整 catalog(设置页消费的那份)不受 availableModels 派生过滤影响,模型仍在。
    expect(xd.models['claude-code']!.some((m) => m.id === 'gpt-image-2')).toBe(true);
    expect(xd.models['claude-code']!.some((m) => m.id === 'text-embedding-3-large')).toBe(true);
  });

  it('retired 模型不进面向旧客户端的新选择清单，但仍留在完整 catalog 供运行中会话解析', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    const provider = catalog.providers.find((entry) => entry.models['claude-code']?.length);
    expect(provider).toBeDefined();
    const retired = provider!.models['claude-code']![0]!;
    retired.status = 'retired';

    expect(deriveAvailableModels(catalog, 'claude-code').some((entry) => entry.id === retired.id))
      .toBe(false);
    expect(provider!.models['claude-code']!.some((entry) => entry.id === retired.id)).toBe(true);
  });

  it('纯 Registry retired 不进入公开清单,但可按统一投影重建 Pi 续跑描述符', () => {
    const catalog = structuredClone(BUNDLED_CATALOG);
    catalog.modelRegistry = {
      schemaVersion: 1,
      updatedAt: '2026-08-02T00:00:00.000Z',
      models: [{
        id: 'openai/gpt-retired',
        name: 'GPT Retired',
        status: 'retired',
        contextWindow: 300_000,
        maxOutputTokens: 96_000,
        efforts: ['low', 'max'],
        defaultEffort: 'max',
        routes: [{ providerId: 'openai', modelId: 'gpt-retired', agents: ['codex'] }],
      }],
    };

    expect(deriveAvailableModels(catalog, 'pi').some((m) => m.id === 'chatgpt/gpt-retired')).toBe(false);
    expect(resolvePiRuntimeModelDescriptor(catalog, 'openai', 'chatgpt/gpt-retired')).toMatchObject({
      id: 'chatgpt/gpt-retired',
      displayName: 'GPT Retired',
      contextWindow: 300_000,
      maxOutputTokens: 96_000,
      efforts: ['minimal', 'low'],
      defaultEffort: 'low',
    });
    expect(resolvePiRuntimeModelDescriptor(catalog, 'anthropic', 'chatgpt/gpt-retired')).toBeNull();
  });

  it('runtime refresh replaces both agent model lists in place so existing sessions keep the live reference', () => {
    const claudeModels: ModelDescriptor[] = [{ id: 'stale-claude', displayName: 'Stale', contextWindow: 1, efforts: [], defaultEffort: null }];
    const codexModels: ModelDescriptor[] = [{ id: 'stale-codex', displayName: 'Stale', contextWindow: 1, efforts: [], defaultEffort: null }];
    const piModels: ModelDescriptor[] = [{ id: 'stale-pi', displayName: 'Stale', contextWindow: 1, efforts: [], defaultEffort: null }];
    const claudeRef = claudeModels;
    const codexRef = codexModels;
    const piRef = piModels;
    const target = {
      getCapabilities(agent: 'claude-code' | 'codex' | 'pi') {
        if (agent === 'pi') return { availableModels: piModels };
        return { availableModels: agent === 'claude-code' ? claudeModels : codexModels };
      },
    };

    refreshCatalogDerivedModels(target, injectedCatalog());

    expect(claudeModels).toBe(claudeRef);
    expect(codexModels).toBe(codexRef);
    expect(piModels).toBe(piRef);
    expect(claudeModels).toEqual(deriveAvailableModels(injectedCatalog(), 'claude-code'));
    expect(codexModels).toEqual(deriveAvailableModels(injectedCatalog(), 'codex'));
    expect(piModels).toEqual(deriveAvailableModels(injectedCatalog(), 'pi'));
  });
});

describe('resolveVerifiedContextWindow — 按路由解析已核实窗口', () => {
  /** 常见双 provider 目录:订阅直连发现的无前缀 id(live-list 兜底 272K,未核实) + 网关下发的同 id(已核实 372K)。 */
  function dualProviderCatalog(): Catalog {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    for (const p of catalog.providers) {
      if (p.id === 'openai') {
        p.models.codex = [model('gpt-5.6-sol', { contextWindow: 272_000 })];
      }
      if (p.id === 'xd') {
        p.models.codex = [
          model('gpt-5.6-sol', { contextWindow: 372_000, contextWindowVerified: true }),
          model('codex/gpt-5.6-sol', { contextWindow: 372_000, contextWindowVerified: true }),
        ];
      }
    }
    return catalog;
  }

  // 这是本 PR 的核心场景:会话明确路由到 xd 时,必须拿到网关声明的 372K —— 不能因为
  // openai 也暴露同一个无前缀 id 就放弃收敛(那会让 app-server 的 1M 原样留下)。
  it('给了 providerId 时只认该路由的条目', () => {
    const catalog = dualProviderCatalog();
    expect(resolveVerifiedContextWindow(catalog, 'codex', 'xd', 'gpt-5.6-sol')).toBe(372_000);
    // openai 那条是 live-list 兜底、未核实 → 不可作上限。
    expect(resolveVerifiedContextWindow(catalog, 'codex', 'openai', 'gpt-5.6-sol')).toBeNull();
  });

  it('没给 providerId 且该 id 跨 provider 有歧义时不收敛', () => {
    expect(resolveVerifiedContextWindow(dualProviderCatalog(), 'codex', null, 'gpt-5.6-sol')).toBeNull();
  });

  it('没给 providerId 但该 id 无歧义时照常返回(折扣路由只由网关提供)', () => {
    expect(
      resolveVerifiedContextWindow(dualProviderCatalog(), 'codex', undefined, 'codex/gpt-5.6-sol'),
    ).toBe(372_000);
  });

  it('候选存在但未标记已核实 → null(派生兜底值只够展示)', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    for (const p of catalog.providers) {
      if (p.id === 'openai') p.models.codex = [model('fallback/only', { contextWindow: 272_000 })];
    }
    expect(resolveVerifiedContextWindow(catalog, 'codex', 'openai', 'fallback/only')).toBeNull();
  });

  it('providerId 指向的路由没有该模型 → null,不回落到别的 provider', () => {
    const catalog = dualProviderCatalog();
    expect(resolveVerifiedContextWindow(catalog, 'codex', 'anthropic', 'gpt-5.6-sol')).toBeNull();
  });

  it('目录未覆盖的模型 → null', () => {
    expect(resolveVerifiedContextWindow(dualProviderCatalog(), 'codex', 'xd', 'nope/unknown')).toBeNull();
  });

  it('该 agent 上被 disabled 的 provider 不参与解析', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    for (const p of catalog.providers) {
      if (p.id !== 'xd') continue;
      p.models.codex = [model('xd/only', { contextWindow: 500_000, contextWindowVerified: true })];
      p.routing.codex = { ...(p.routing.codex ?? {}), disabled: true } as typeof p.routing.codex;
    }
    expect(resolveVerifiedContextWindow(catalog, 'codex', 'xd', 'xd/only')).toBeNull();
  });
});
