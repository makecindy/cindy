/**
 * 目录校验 + 内置供应商契约(2026-07-19 模型列表统一重构后的新契约)。
 *
 * **清单来源唯一化**——
 *   - anthropic / openai / xd 是动态清单供应商:bundled 目录只有身份卡,models 恒为空,
 *     清单运行时由 host 注入(SDK 发现 / codex 注册表 / 网关下发);
 *   - xai 的静态段是离线 fallback/元数据层；登录后的成员由账号发现决定;
 *   - presets 是自定义供应商模板,随目录 OSS 热更。
 *
 * 本测试守:(a) bundled 结构合法且符合上述形态;(b) parseCatalog 校验规则
 * (含动态供应商的 titleModel 豁免);(c) registry 的来源/fast 解析逻辑在
 * 「运行时注入后的目录」上行为正确(用注入 fixture 模拟生产形态)。
 */

import { describe, it, expect } from 'vitest';

import { BUNDLED_CATALOG, parseCatalog } from '../catalog.js';
import {
  buildRegistry,
  sourcesForModel,
  modelSupportsFastMode,
  sessionModelSupportsFastMode,
} from '../registry.js';
import type { AgentKind, Catalog, CatalogModel } from '../types.js';

/** 动态清单供应商(bundled 零模型,运行时注入)。 */
const DYNAMIC_PROVIDER_IDS = ['anthropic', 'openai', 'xd'] as const;

/** xAI 随包 fallback 元数据清单。 */
const EXPECTED_XAI_IDS = [
  'xai/grok-4.5',
  'xai/grok-4.3',
  'xai/grok-build-0.1',
  'xai/grok-4.20-multi-agent-0309',
  'xai/grok-4.20-0309-reasoning',
  'xai/grok-4.20-0309-non-reasoning',
  'xai/grok-4.20',
  'xai/grok-code-fast',
];
const EXPECTED_XAI_PI_IDS = ['grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-build-0.1'];

function provider(id: string) {
  const p = BUNDLED_CATALOG.providers.find((x) => x.id === id);
  if (!p) throw new Error(`missing provider ${id}`);
  return p;
}

function registryEntryForRoute(providerId: string, modelId: string) {
  const registry = BUNDLED_CATALOG.modelRegistry;
  if (!registry) throw new Error('missing bundled modelRegistry');
  const entry = registry.models.find((candidate) =>
    candidate.routes.some(
      (route) => route.providerId === providerId && route.modelId === modelId,
    ),
  );
  if (!entry) throw new Error(`missing registry route ${providerId}/${modelId}`);
  return entry;
}

/** 造一个最小 CatalogModel(注入 fixture 用)。 */
function model(id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: [],
    defaultEffort: null,
    ...extra,
  };
}

/** 模拟生产形态:把动态清单注入 bundled 副本(anthropic SDK 发现 / codex 注册表 / 网关下发)。 */
function runtimeCatalog(): Catalog {
  const clone = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  for (const p of clone.providers) {
    if (p.id === 'anthropic') {
      const anthropic = [
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, supportsFastMode: true }),
        model('claude-sonnet-4-6', { name: 'Sonnet 4.6', contextWindow: 1_000_000 }),
      ];
      p.models['claude-code'] = anthropic;
      p.models.codex = anthropic;
    }
    if (p.id === 'openai') {
      p.models.codex = [model('gpt-5.5', { name: 'GPT-5.5', supportsFastMode: true })];
      p.models['claude-code'] = [model('chatgpt/gpt-5.5', { name: 'GPT-5.5', supportsFastMode: true })];
    }
    if (p.id === 'xd') {
      p.models['claude-code'] = [
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, supportsFastMode: false }),
        model('gpt-5.5', { name: 'GPT-5.5', supportsFastMode: true }),
      ];
      p.models.codex = [model('gpt-5.5', { name: 'GPT-5.5', supportsFastMode: true })];
    }
  }
  return clone;
}

describe('bundled catalog validity (dynamic-first contract)', () => {
  it('parses & passes schema validation', () => {
    expect(() => parseCatalog(BUNDLED_CATALOG)).not.toThrow();
  });

  it('keeps selectable registry efforts self-consistent with defaultEffort', () => {
    const registry = BUNDLED_CATALOG.modelRegistry;
    expect(registry).toBeDefined();
    for (const entry of registry!.models) {
      const efforts = entry.efforts ?? [];
      if (efforts.length === 0) continue;
      expect(entry.defaultEffort, entry.id).toBeTruthy();
      expect(efforts, entry.id).toContain(entry.defaultEffort);
    }
    expect(registryEntryForRoute('openai', 'gpt-5.6-luna')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
    expect(registryEntryForRoute('openai', 'gpt-5.4-nano')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
    });
    // Corrections must forward-fix: same updatedAt + different content is a
    // conflict, so cached clients would keep the entries without defaultEffort.
    expect(Date.parse(registry!.updatedAt)).toBeGreaterThan(Date.parse('2026-08-05T00:00:00.000Z'));
  });

  it('has exactly the built-in providers in stable order', () => {
    // 顺序契约:决定选择器分段顺序与 deriveAvailableModels first-wins 优先级。
    expect(BUNDLED_CATALOG.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'xai', 'xd', 'gemini']);
    expect(BUNDLED_CATALOG.providers.every((p) => p.source === 'builtin')).toBe(true);
  });

  it('dynamic providers ship ZERO static models (list is runtime-injected, no fallback)', () => {
    for (const id of DYNAMIC_PROVIDER_IDS) {
      const p = provider(id);
      for (const agent of p.agents) {
        expect(p.models[agent], `${id} models[${agent}] must exist (empty array)`).toEqual([]);
      }
    }
  });

  it('xai ships a static fallback list and Pi official metadata', () => {
    const xai = provider('xai');
    expect((xai.models['claude-code'] ?? []).map((m) => m.id)).toEqual(EXPECTED_XAI_IDS);
    expect((xai.models.codex ?? []).map((m) => m.id)).toEqual(EXPECTED_XAI_IDS);
    expect((xai.models.pi ?? []).map((m) => m.id)).toEqual(EXPECTED_XAI_PI_IDS);
    expect(xai.models.pi?.find((m) => m.id === 'grok-4.6')).toMatchObject({
      contextWindow: 500_000,
      maxOutput: 500_000,
      supportsImageInput: true,
      efforts: [],
      defaultEffort: null,
    });
  });

  it('xai ships both Grok Imagine subscription image models', () => {
    expect(provider('xai').imageModels).toEqual([
      { id: 'xai/grok-imagine-image', name: 'Grok Imagine Image' },
      { id: 'xai/grok-imagine-image-quality', name: 'Grok Imagine Image (Quality)' },
    ]);
  });

  it('xai ships the Grok Imagine subscription video model', () => {
    expect(provider('xai').videoModels).toEqual([
      { id: 'xai/grok-imagine-video', name: 'Grok Imagine Video' },
    ]);
  });

  it('provides routing + a models[agent] array for every agent the provider declares', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      for (const a of p.agents) {
        expect(p.routing[a], `${p.id} routing[${a}]`).toBeTruthy();
        expect(Array.isArray(p.models[a]), `${p.id} models[${a}]`).toBe(true);
      }
    }
  });

  it('declares access separately from model names', () => {
    expect(provider('anthropic').access).toEqual({ kind: 'subscription', product: 'Claude.ai' });
    expect(provider('openai').access).toEqual({ kind: 'subscription', product: 'ChatGPT' });
    expect(provider('xai').access).toEqual({ kind: 'subscription', product: 'SuperGrok' });
    expect(provider('xd').access).toEqual({ kind: 'managed' });
    for (const p of BUNDLED_CATALOG.providers) {
      if (p.access?.kind !== 'subscription') continue;
      const product = p.access.product;
      for (const models of Object.values(p.models)) {
        expect(models?.every((m) => !m.name.includes(product) && !m.name.includes('订阅'))).toBe(true);
      }
    }
  });

  it('rejects malformed provider access metadata', () => {
    for (const access of [null, { kind: 'metered' }, { kind: 'subscription' }, { kind: 'subscription', product: ' ' }]) {
      const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
      (bad.providers[0] as unknown as Record<string, unknown>).access = access;
      expect(() => parseCatalog(bad)).toThrow(/access/);
    }
  });

  it('model.icon 可选:合法字符串放行,空白串拒绝(展示图标以 AI Gateway / 目录设定为准)', () => {
    const ok = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xaiOk = ok.providers.find((p) => p.id === 'xai')!;
    xaiOk.models['claude-code']![0].icon = 'claude';
    expect(() => parseCatalog(ok)).not.toThrow();

    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xaiBad = bad.providers.find((p) => p.id === 'xai')!;
    xaiBad.models['claude-code']![0].icon = '  ';
    expect(() => parseCatalog(bad)).toThrow(/icon/);
  });

  it('accepts the four portable piApi values and rejects unknown PI protocols', () => {
    for (const piApi of [
      'anthropic-messages',
      'openai-responses',
      'openai-completions',
      'google-generative-ai',
    ] as const) {
      const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
      catalog.providers.find((provider) => provider.id === 'xai')!
        .models['claude-code']![0]!.piApi = piApi;
      expect(() => parseCatalog(catalog)).not.toThrow();
    }

    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    (bad.providers.find((provider) => provider.id === 'xai')!
      .models['claude-code']![0] as unknown as Record<string, unknown>).piApi = 'claude-v1';
    expect(() => parseCatalog(bad)).toThrow(/piApi/);
  });

  it('ships custom-provider presets (OSS 热更的第三方模板)', () => {
    const presets = BUNDLED_CATALOG.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.map((p) => p.id)).toContain('openrouter');
  });

  it('DeepSeek 预设携带厂商文档确认的 1M contextWindow (#735)', () => {
    // 官方 V4 起全线 1M(api-docs.deepseek.com news260424);预设不带时
    // buildUserProvider 回落 200K 保守默认,长上下文模型被错误降级。
    const presets = BUNDLED_CATALOG.presets ?? [];
    const deepseek = presets.find((p) => p.id === 'deepseek');
    expect(deepseek).toBeDefined();
    for (const [agent, rt] of Object.entries(deepseek!.runtimes)) {
      for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
        const m = rt!.models.find((x) => x.id === id);
        expect(m?.contextWindow, `${agent}/${id}`).toBe(1_000_000);
      }
    }
    // OpenRouter 托管的同款模型页面同样标注 1,048,576,取与仓库口径一致的 1M。
    const openrouter = presets.find((p) => p.id === 'openrouter');
    expect(
      openrouter?.runtimes['claude-code']?.models.find((m) => m.id === 'deepseek/deepseek-v4-pro')
        ?.contextWindow,
    ).toBe(1_000_000);
    expect(deepseek?.runtimes.pi).toMatchObject({
      wireProtocol: 'openai-chat',
      models: [
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' },
      ],
    });
  });

  it('Kimi Code(编程计划)按各 harness 的权威目录保留 contextWindow', () => {
    const presets = BUNDLED_CATALOG.presets ?? [];
    const kimiCode = presets.find((p) => p.id === 'moonshot-kimi-code');
    expect(kimiCode).toBeDefined();
    for (const [agent, rt] of Object.entries(kimiCode!.runtimes)) {
      for (const m of rt!.models) {
        expect(
          Number.isFinite(m.contextWindow) && (m.contextWindow ?? 0) > 0,
          `${agent}/${m.id} 缺 contextWindow`,
        ).toBe(true);
      }
      expect(rt!.models.find((m) => m.id === 'k3')?.contextWindow, `${agent}/k3`).toBe(
        agent === 'pi' ? 1_048_576 : 262_144,
      );
    }
  });

  it('ships Codex support metadata for the current XD gateway model set', () => {
    const expected = {
      'qwen/qwen3.7-max': 'Qwen 3.7 Max',
      'moonshotai/kimi-k3': 'Kimi K3',
      'z-ai/glm-5.2': 'GLM-5.2',
      'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'bytedance-seed/seed-2.1-pro': 'Seed 2.1 Pro',
      'qwen/qwen3.8-max-preview': 'Qwen 3.8 Max Preview',
    };
    for (const [id, name] of Object.entries(expected)) {
      const entry = registryEntryForRoute('xd', id);
      const route = entry.routes.find(
        (candidate) => candidate.providerId === 'xd' && candidate.modelId === id,
      );
      expect(entry, id).toMatchObject({ name });
      expect(route?.agents, id).toEqual(['claude-code', 'codex']);
    }

    expect(registryEntryForRoute('xd', 'bytedance-seed/seed-2.1-pro')).toMatchObject({
      efforts: ['minimal', 'low', 'medium', 'high'],
      defaultEffort: 'minimal',
      supportsFastMode: false,
      perAgent: {
        'claude-code': {
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'low',
        },
      },
    });
    expect(registryEntryForRoute('xd', 'moonshotai/kimi-k3')).toMatchObject({
      efforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      supportsFastMode: false,
    });
    expect(registryEntryForRoute('xd', 'qwen/qwen3.8-max-preview')).toMatchObject({
      efforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'xhigh',
      supportsFastMode: false,
    });
    expect(registryEntryForRoute('xd', 'z-ai/glm-5.2')).toMatchObject({
      efforts: ['minimal', 'high', 'max'],
      defaultEffort: 'max',
      supportsFastMode: false,
      perAgent: {
        'claude-code': {
          efforts: ['high', 'max'],
          defaultEffort: 'max',
        },
      },
    });
    for (const id of ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash']) {
      expect(registryEntryForRoute('xd', id), id).toMatchObject({
        efforts: ['high', 'max'],
        defaultEffort: 'high',
        supportsFastMode: false,
      });
    }
    for (const id of [
      'bytedance-seed/seed-2.1-pro',
      'moonshotai/kimi-k3',
      'qwen/qwen3.8-max-preview',
    ]) {
      expect(registryEntryForRoute('xd', id), id).not.toHaveProperty('description');
    }
  });

  it('enables DeepSeek V4 Flash by default', () => {
    expect(
      registryEntryForRoute('xd', 'deepseek/deepseek-v4-flash').defaultEnabled,
    ).toBeUndefined();
  });

  it('rejects legacy or ad-hoc top-level metadata blocks', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Record<string, unknown>;
    bad.cindyModelMeta = { version: 1, models: {} };
    expect(() => parseCatalog(bad)).toThrow(/catalog\.cindyModelMeta is not allowed/);
  });

  it('models are grouped per-agent (no flat array, no rogue agent keys)', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      expect(Array.isArray(p.models), `${p.id} models must be a per-agent map`).toBe(false);
      for (const key of Object.keys(p.models)) {
        expect(p.agents, `${p.id} stray models[${key}]`).toContain(key);
      }
    }
  });
});

describe('titleModel 契约(动态供应商豁免静态存在性校验)', () => {
  it('builtin providers configure titleModel for one-shot titles', () => {
    expect(provider('anthropic').titleModel).toBe('claude-haiku-4-5');
    expect(provider('openai').titleModel).toBe('gpt-5.4-mini');
    expect(provider('xd').titleModel).toBe('gpt-5.4-mini');
  });

  it('parseCatalog allows titleModel on a dynamic-list provider (all models empty)', () => {
    // bundled 的 anthropic/openai/xd 正是这种形态,上面的 parse 测试已覆盖;这里显式守语义。
    expect(() => parseCatalog(BUNDLED_CATALOG)).not.toThrow();
  });

  it('parseCatalog still rejects titleModel not found in a static (non-empty) list', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai')!;
    xai.titleModel = 'no-such-model';
    expect(() => parseCatalog(bad)).toThrow(/titleModel/);
  });
});

/**
 * 路由服务范围(modelPrefixes)契约 —— issue #886 的长期防线。
 * 详注见 git 历史;要点:模型清单整体活在 `<ns>/` 命名空间的 (provider, agent)
 * 必须声明 modelPrefixes,否则会话内 claude-* 辅助请求会被误路由。
 */
describe('routing modelPrefixes 服务范围契约 (issue #886)', () => {
  it('模型清单整体带命名空间前缀的 (provider, agent) 必须声明 modelPrefixes,且覆盖全部模型 id', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      for (const agent of p.agents) {
        const models = p.models[agent] ?? [];
        if (models.length === 0) continue;
        const allNamespaced = models.every((m) => m.id.includes('/'));
        if (!allNamespaced) continue;
        const prefixes = p.routing[agent]?.modelPrefixes;
        expect(
          prefixes && prefixes.length > 0,
          `${p.id} routing[${agent}] 的模型全部在命名空间下,必须声明 modelPrefixes`,
        ).toBe(true);
        for (const m of models) {
          expect(
            (prefixes ?? []).some((prefix) => m.id.startsWith(prefix)),
            `${p.id} routing[${agent}].modelPrefixes 未覆盖模型 '${m.id}'`,
          ).toBe(true);
        }
      }
    }
  });

  it('桥接型动态供应商(openai cc)的 modelPrefixes 保持声明(清单为空时范围门依然生效)', () => {
    // openai claude-code 的动态清单全部落在 chatgpt/ 命名空间;静态清单虽空,
    // 路由范围门必须常驻——否则 cc 会话的 claude-* 辅助请求会被误送 chatgpt 后端。
    expect(provider('openai').routing['claude-code']?.modelPrefixes).toEqual(['chatgpt/']);
    expect(provider('xai').routing['claude-code']?.modelPrefixes).toEqual(['xai/']);
    expect(provider('xai').routing.codex?.modelPrefixes).toEqual(['xai/']);
  });

  it('声明的前缀必须是 `<ns>/` 命名空间形态', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      for (const agent of p.agents) {
        for (const prefix of p.routing[agent]?.modelPrefixes ?? []) {
          expect(prefix, `${p.id} routing[${agent}] prefix '${prefix}'`).toMatch(/^[a-zA-Z0-9_-]+\/$/);
        }
      }
    }
  });

  it('parseCatalog 拒绝非命名空间形态的 modelPrefixes(如裸 "claude")', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai')!;
    xai.routing['claude-code'] = { ...xai.routing['claude-code']!, modelPrefixes: ['claude'] };
    expect(() => parseCatalog(bad)).toThrow(/modelPrefixes/);
  });

  it('parseCatalog 拒绝空数组 modelPrefixes(声明了就必须有内容)', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai')!;
    xai.routing['claude-code'] = { ...xai.routing['claude-code']!, modelPrefixes: [] };
    expect(() => parseCatalog(bad)).toThrow(/modelPrefixes/);
  });
});

describe('routing wireProtocol per-agent 契约', () => {
  it('parseCatalog 拒绝 claude-code 使用 openai-chat', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const anthropic = bad.providers.find((p) => p.id === 'anthropic')!;
    anthropic.routing['claude-code'] = { ...anthropic.routing['claude-code']!, wireProtocol: 'openai-chat' };
    expect(() => parseCatalog(bad)).toThrow(/openai-chat/);
  });

  it('parseCatalog 允许 codex 使用 anthropic-messages(由本地 Responses→Anthropic bridge 接管)', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai')!;
    xai.routing.codex = { ...xai.routing.codex!, wireProtocol: 'anthropic-messages' };
    expect(parseCatalog(bad).providers.find((p) => p.id === 'xai')?.routing.codex?.wireProtocol)
      .toBe('anthropic-messages');
  });
});

describe('runtime-injected registry semantics(生产形态:动态清单注入后)', () => {
  const views = buildRegistry(runtimeCatalog(), { anthropic: true, openai: true, xai: true, xd: true });

  it('claude 模型 cc 双来源(anthropic+xd);gpt cc 单来源(xd);gpt codex 双来源(openai+xd)', () => {
    expect(sourcesForModel(views, 'claude-opus-4-8', 'claude-code').map((p) => p.id).sort()).toEqual(['anthropic', 'xd']);
    expect(sourcesForModel(views, 'gpt-5.5', 'claude-code').map((p) => p.id)).toEqual(['xd']);
    expect(sourcesForModel(views, 'gpt-5.5', 'codex').map((p) => p.id).sort()).toEqual(['openai', 'xd']);
  });

  it('xai/grok 模型只经 xAI 提供(bundled 静态清单)', () => {
    expect(sourcesForModel(views, 'xai/grok-4.3', 'codex').map((p) => p.id)).toEqual(['xai']);
    expect(sourcesForModel(views, 'xai/grok-4.3', 'claude-code').map((p) => p.id)).toEqual(['xai']);
  });

  it('未注入时(bundled 原样)动态供应商零来源——不用静态数据冒充', () => {
    const bare = buildRegistry(BUNDLED_CATALOG, { anthropic: true, openai: true, xai: true, xd: true });
    expect(sourcesForModel(bare, 'claude-opus-4-8', 'claude-code')).toEqual([]);
    expect(sourcesForModel(bare, 'gpt-5.5', 'codex')).toEqual([]);
    expect(sourcesForModel(bare, 'xai/grok-4.3', 'codex').map((p) => p.id)).toEqual(['xai']);
  });
});

describe('fast-mode per-provider resolution (model-level SSoT)', () => {
  it('modelSupportsFastMode reads the specific provider entry (false on missing provider/model)', () => {
    const views = buildRegistry(runtimeCatalog(), {});
    const anthropic = views.find((p) => p.id === 'anthropic');
    const xd = views.find((p) => p.id === 'xd');
    // opus per-provider 分叉:anthropic(直连,SDK 声明支持)=true,xd(网关下发 false)=false。
    expect(modelSupportsFastMode(anthropic, 'claude-opus-4-8', 'claude-code')).toBe(true);
    expect(modelSupportsFastMode(xd, 'claude-opus-4-8', 'claude-code')).toBe(false);
    expect(modelSupportsFastMode(anthropic, 'gpt-5.5', 'claude-code')).toBe(false);
    expect(modelSupportsFastMode(undefined, 'claude-opus-4-8', 'claude-code')).toBe(false);
    expect(modelSupportsFastMode(anthropic, 'claude-sonnet-4-6', 'claude-code')).toBe(false);
  });

  it('sessionModelSupportsFastMode resolves the effective source then reads its entry', () => {
    const both = buildRegistry(runtimeCatalog(), { xd: true, anthropic: true });
    // 未显式选源 → cc 原生默认 xd;xd 的 opus supportsFastMode=false ⇒ false。
    expect(sessionModelSupportsFastMode(both, null, 'claude-opus-4-8', 'claude-code')).toBe(false);
    expect(sessionModelSupportsFastMode(both, 'anthropic', 'claude-opus-4-8', 'claude-code')).toBe(true);
    expect(sessionModelSupportsFastMode(both, null, 'claude-sonnet-4-6', 'claude-code')).toBe(false);
    expect(sessionModelSupportsFastMode(buildRegistry(runtimeCatalog(), {}), null, 'claude-opus-4-8', 'claude-code')).toBe(false);
  });

  it('parser ALLOWS per-provider fast divergence(同 id 跨 provider fast 不参与一致性校验)', () => {
    const divergent: Catalog = {
      version: '1',
      providers: [
        {
          id: 'p-fast', name: 'P-Fast', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'managed' },
          routing: { 'claude-code': { upstream: 'https://a', authStrategy: 'gateway-key' } },
          models: { 'claude-code': [model('m1', { name: 'M1', supportsFastMode: true })] },
        },
        {
          id: 'p-slow', name: 'P-Slow', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'managed' },
          routing: { 'claude-code': { upstream: 'https://b', authStrategy: 'gateway-key' } },
          models: { 'claude-code': [model('m1', { name: 'M1', supportsFastMode: false })] },
        },
      ],
    };
    expect(() => parseCatalog(divergent)).not.toThrow();
  });
});

describe('vendor grouping metadata (xai fallback metadata)', () => {
  it('every static model carries group=grok + numeric sortOrder', () => {
    const xai = provider('xai');
    for (const agent of xai.agents) {
      for (const m of xai.models[agent] ?? []) {
        expect(m.group, `${m.id} group`).toBe('grok');
        expect(typeof m.sortOrder, `${m.id} sortOrder`).toBe('number');
      }
    }
  });

  // 静态目录里的窗口是产品侧逐条写定的真实上限 —— 必须标记为已核实,否则运行期收敛不掉
  // 上游报的虚高窗口(例:256K 的 xai/grok-code-fast 被报成基础模型的更大值)。
  it('静态清单的 contextWindow 标记为已核实(可用于收敛上报值)', () => {
    const xai = provider('xai');
    for (const agent of xai.agents) {
      for (const m of xai.models[agent] ?? []) {
        expect(m.contextWindow, `${m.id} contextWindow`).toBeGreaterThan(0);
        expect(m.contextWindowVerified, `${m.id} contextWindowVerified`).toBe(true);
      }
    }
  });

  // 远端下发目录与 bundled 同格式,同样要在解析时标记;条目自己表过态时尊重原值。
  it('parseCatalog 给远端下发的静态条目补标记,但不覆盖显式表态', () => {
    const parsed = parseCatalog({
      version: '2',
      providers: [
        {
          ...provider('xai'),
          models: {
            codex: [
              { id: 'remote/known', name: 'Known', contextWindow: 262_144, efforts: [], defaultEffort: null, group: 'grok', sortOrder: 1 },
              { id: 'remote/opted-out', name: 'Opted Out', contextWindow: 272_000, contextWindowVerified: false, efforts: [], defaultEffort: null, group: 'grok', sortOrder: 2 },
            ],
          },
          agents: ['codex'],
          titleModel: 'remote/known',
        },
      ],
    });
    const models = parsed.providers[0].models.codex ?? [];
    expect(models.find((m) => m.id === 'remote/known')?.contextWindowVerified).toBe(true);
    expect(models.find((m) => m.id === 'remote/opted-out')?.contextWindowVerified).toBe(false);
  });
});

describe('provider OAuth and upstream URL validation', () => {
  const oauthCatalog = (): Catalog => ({
    version: '1',
    providers: [{
      id: 'oauth-provider',
      name: 'OAuth Provider',
      source: 'builtin',
      agents: ['codex'],
      auth: {
        method: 'oauth',
        oauth: {
          flow: 'authorization-code',
          authorizeUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          clientId: 'client',
          scopes: 'openid',
        },
      },
      routing: {
        codex: {
          upstream: 'https://api.example/v1',
          authStrategy: 'oauth-token',
        },
      },
      models: { codex: [model('m1')] },
    }],
  });

  it('rejects fields from the other OAuth flow', () => {
    const authorizationCode = oauthCatalog();
    Object.assign(authorizationCode.providers[0]!.auth.oauth!, {
      deviceAuthorizationUrl: 'https://auth.example/device',
    });
    expect(() => parseCatalog(authorizationCode)).toThrow(/device-code fields/);

    const deviceCode = oauthCatalog();
    deviceCode.providers[0]!.auth.oauth = {
      flow: 'device-code',
      deviceAuthorizationUrl: 'https://auth.example/device',
      tokenUrl: 'https://auth.example/token',
      clientId: 'client',
      scopes: 'openid',
      authorizeUrl: 'https://auth.example/authorize',
    } as never;
    expect(() => parseCatalog(deviceCode)).toThrow(/authorization-code fields/);
  });

  it('rejects reserved OAuth extra params case-insensitively', () => {
    const catalog = oauthCatalog();
    catalog.providers[0]!.auth.oauth!.extraAuthParams = {
      Client_Id: 'shadow-client',
    };
    expect(() => parseCatalog(catalog)).toThrow(/cannot override 'Client_Id'/);
  });

  it('rejects an OAuth descriptor on a non-OAuth auth method', () => {
    const catalog = oauthCatalog();
    catalog.providers[0]!.auth = {
      method: 'none',
      oauth: catalog.providers[0]!.auth.oauth,
    } as never;
    expect(() => parseCatalog(catalog)).toThrow(/auth\.oauth not allowed for none method/);
  });

  it('rejects an upstream URL with embedded credentials', () => {
    const catalog = oauthCatalog();
    catalog.providers[0]!.routing.codex!.upstream = 'https://user:pass@api.example/v1';
    expect(() => parseCatalog(catalog)).toThrow(/upstream invalid/);
  });

  it('accepts a same-origin Responses model route', () => {
    const catalog = oauthCatalog();
    catalog.providers[0]!.models.codex![0] = model('m1', {
      route: {
        baseUrl: 'https://api.example/v1',
        wireProtocol: 'openai-responses',
        requestPath: '/responses',
      },
    });
    expect(parseCatalog(catalog).providers[0]!.models.codex![0]!.route).toEqual({
      baseUrl: 'https://api.example/v1',
      wireProtocol: 'openai-responses',
      requestPath: '/responses',
    });
  });

  it.each([
    ['non-object route', null],
    ['missing base URL', { wireProtocol: 'openai-responses' }],
    ['cross-origin base URL', { baseUrl: 'https://other.example/v1', wireProtocol: 'openai-responses' }],
    ['embedded credentials', { baseUrl: 'https://user:pass@api.example/v1', wireProtocol: 'openai-responses' }],
    ['invalid protocol', { baseUrl: 'https://api.example/v1', wireProtocol: 'invalid' }],
    ['unsafe request path', { baseUrl: 'https://api.example/v1', wireProtocol: 'openai-responses', requestPath: '//other.example' }],
    ['Claude-incompatible protocol', { baseUrl: 'https://api.example/v1', wireProtocol: 'openai-responses' }],
  ])('rejects %s model routes', (_label, route) => {
    const catalog = oauthCatalog();
    if (_label === 'Claude-incompatible protocol') {
      catalog.providers[0]!.agents = ['claude-code'];
      catalog.providers[0]!.routing = {
        'claude-code': {
          upstream: 'https://api.example/v1',
          authStrategy: 'oauth-token',
        },
      };
      catalog.providers[0]!.models = { 'claude-code': [model('m1', { route })] };
    } else {
      catalog.providers[0]!.models.codex![0] = model('m1', { route });
    }
    expect(() => parseCatalog(catalog)).toThrow(/model\.route invalid/);
  });
});

describe('buildRegistry 的清单发现失败投影', () => {
  const failure = {
    kind: 'regionBlocked' as const,
    at: '2026-07-27T00:00:00.000Z',
    detail: 'HTTP 403: {"error":{"type":"unsupported_country_region_territory"}}',
  };

  it('剥掉 detail 再下发 —— 原始上游响应体不出 Main', () => {
    const views = buildRegistry(BUNDLED_CATALOG, { anthropic: true }, { anthropic: failure });
    const anthropic = views.find((p) => p.id === 'anthropic');
    expect(anthropic?.modelDiscoveryFailure).toEqual({ kind: 'regionBlocked', at: failure.at });
    expect(anthropic?.modelDiscoveryFailure).not.toHaveProperty('detail');
    // 原对象不被就地改坏:host 侧还要拿 detail 写日志。
    expect(failure.detail).toContain('unsupported_country_region_territory');
  });

  it('没有失败态的供应商不长出该字段;稀疏 map 缺键也不报错', () => {
    const views = buildRegistry(BUNDLED_CATALOG, { anthropic: true }, { anthropic: null });
    expect(views.find((p) => p.id === 'anthropic')?.modelDiscoveryFailure).toBeUndefined();
    const bare = buildRegistry(BUNDLED_CATALOG, { anthropic: true });
    expect(bare.find((p) => p.id === 'anthropic')?.modelDiscoveryFailure).toBeUndefined();
  });
});

describe('媒体清单跨供应商契约(2026-07 图像多来源)', () => {
  // deriveCindyMediaConfig(desktop 侧)按目录序 first-wins 选默认与归属:
  // BUILTIN 顺序里 openai/xai 排在 xd 前面,任何非 xd 供应商声明 imageDefaults
  // 都会把 xd 的出厂默认顶掉;同 id 撞车会把 xd 条目的归属抢走(派发错通道)。
  // 这两条是数据契约,在目录层锁死,不等运行时踩雷。
  it('声明 imageDefaults / videoDefaults 的内置供应商只能是 xd(防 first-wins 顶默认)', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      if (p.id === 'xd') continue;
      expect(p.imageDefaults, `${p.id} 不得声明 imageDefaults`).toBeUndefined();
      expect(p.videoDefaults, `${p.id} 不得声明 videoDefaults`).toBeUndefined();
    }
  });

  it('embeddingModels / embeddingDefaults 与 image/video 同一套入口校验', () => {
    // 不校验的话坏数据能通过 parseCatalog,随后在 deriveCindyMediaConfig 的
    // for...of 里抛错、被上层降级成空清单 —— 表现是所有插件向量请求变
    // NO_CANDIDATE,而真正的原因在目录里,排查时毫无线索(PR #1707 review)。
    const withXd = (mutate: (xd: Record<string, unknown>) => void): Catalog => {
      const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
      mutate(bad.providers.find((p) => p.id === 'xd')! as unknown as Record<string, unknown>);
      return bad;
    };

    // 写成对象而不是数组(远端手写目录最常见的形态错误)。
    expect(() => parseCatalog(withXd((xd) => { xd.embeddingModels = { a: 1 }; })))
      .toThrow(/embeddingModels/);
    // 条目缺 id / name。
    expect(() => parseCatalog(withXd((xd) => { xd.embeddingModels = [{ name: 'x' }]; })))
      .toThrow(/embeddingModels/);
    expect(() => parseCatalog(withXd((xd) => { xd.embeddingModels = [{ id: 'a', name: '' }]; })))
      .toThrow(/embeddingModels/);
    // id 重复(first-wins 去重会静默吃掉后一条)。
    expect(() =>
      parseCatalog(
        withXd((xd) => {
          xd.embeddingModels = [{ id: 'a', name: 'A' }, { id: 'a', name: 'A2' }];
          xd.embeddingDefaults = { standard: 'a' };
        }),
      ),
    ).toThrow(/duplicate/);
    // 默认指向清单外型号(型号下架、默认没跟着改)。
    expect(() =>
      parseCatalog(
        withXd((xd) => {
          xd.embeddingModels = [{ id: 'a', name: 'A' }];
          xd.embeddingDefaults = { standard: 'not-in-list' };
        }),
      ),
    ).toThrow(/embeddingDefaults/);
  });

  it('只声明向量清单的供应商可以没有 agents(媒体-only 同理)', () => {
    const cat = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xd = cat.providers.find((p) => p.id === 'xd')!;
    xd.agents = [];
    xd.models = {};
    xd.routing = {};
    delete xd.imageModels;
    delete xd.imageDefaults;
    delete xd.videoModels;
    delete xd.videoDefaults;
    expect(() => parseCatalog(cat)).not.toThrow();
  });

  it('非 xd 内置供应商的媒体模型 id 必须带 "<providerId>/" 前缀(防 first-wins 归属漂移)', () => {
    for (const p of BUNDLED_CATALOG.providers) {
      if (p.id === 'xd') continue;
      for (const m of [...(p.imageModels ?? []), ...(p.videoModels ?? [])]) {
        expect(
          m.id.startsWith(`${p.id}/`),
          `${p.id} 的媒体模型 ${m.id} 必须带 "${p.id}/" 前缀`,
        ).toBe(true);
      }
    }
  });
});
