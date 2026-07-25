/**
 * 目录校验 + 内置供应商契约(2026-07-19 模型列表统一重构后的新契约)。
 *
 * **清单来源唯一化**——
 *   - anthropic / openai / xd 是动态清单供应商:bundled 目录只有身份卡,models 恒为空,
 *     清单运行时由 host 注入(SDK 发现 / codex 注册表 / 网关下发);
 *   - xai 是唯一的静态清单供应商(官方无列模型通道),清单活在 catalog/providers.json;
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

/** xai 静态清单(唯一活在目录文件里的模型清单)。 */
const EXPECTED_XAI_IDS = ['xai/grok-4.5', 'xai/grok-4.3', 'xai/grok-4.20', 'xai/grok-code-fast'];

function provider(id: string) {
  const p = BUNDLED_CATALOG.providers.find((x) => x.id === id);
  if (!p) throw new Error(`missing provider ${id}`);
  return p;
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
      p.models['claude-code'] = [
        model('claude-opus-4-8', { name: 'Opus 4.8', contextWindow: 1_000_000, supportsFastMode: true }),
        model('claude-sonnet-4-6', { name: 'Sonnet 4.6', contextWindow: 1_000_000 }),
      ];
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

  it('has exactly the built-in providers in stable order', () => {
    // 顺序契约:决定选择器分段顺序与 deriveAvailableModels first-wins 优先级。
    expect(BUNDLED_CATALOG.providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'xai', 'xd']);
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

  it('xai is the only provider with a static model list', () => {
    const xai = provider('xai');
    expect((xai.models['claude-code'] ?? []).map((m) => m.id)).toEqual(EXPECTED_XAI_IDS);
    expect((xai.models.codex ?? []).map((m) => m.id)).toEqual(EXPECTED_XAI_IDS);
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

  it('ships custom-provider presets (OSS 热更的第三方模板)', () => {
    const presets = BUNDLED_CATALOG.presets ?? [];
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.map((p) => p.id)).toContain('openrouter');
  });

  it('ships Codex support metadata for the current XD gateway model set', () => {
    const metadata = BUNDLED_CATALOG.cindyModelMeta as {
      version?: unknown;
      models?: Record<string, unknown>;
    };
    expect(metadata.version).toBe(1);
    const expected = {
      'qwen/qwen3.7-max': 'Qwen 3.7 Max',
      'moonshot/kimi-k3': 'Kimi K3',
      'z-ai/glm-5.2': 'GLM-5.2',
      'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
      'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
      'bytedance-seed/seed-2.1-pro': 'Seed 2.1 Pro',
      'qwen/qwen3.8-max-preview': 'Qwen 3.8 Max Preview',
    };
    for (const [id, name] of Object.entries(expected)) {
      expect(metadata.models?.[id], id).toMatchObject({
        agents: ['claude-code', 'codex'],
        name,
      });
    }
  });

  it('enables DeepSeek V4 Flash by default', () => {
    const metadata = BUNDLED_CATALOG.cindyModelMeta as {
      models?: Record<string, { defaultEnabled?: boolean }>;
    };
    expect(metadata.models?.['deepseek/deepseek-v4-flash']?.defaultEnabled).toBeUndefined();
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

  it('parseCatalog 拒绝 codex 使用 anthropic-messages(codex host 只实现 Responses 与本地 Chat 桥)', () => {
    const bad = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    const xai = bad.providers.find((p) => p.id === 'xai')!;
    xai.routing.codex = { ...xai.routing.codex!, wireProtocol: 'anthropic-messages' };
    expect(() => parseCatalog(bad)).toThrow(/anthropic-messages/);
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

describe('vendor grouping metadata (xai 静态清单)', () => {
  it('every static model carries group=grok + numeric sortOrder', () => {
    const xai = provider('xai');
    for (const agent of xai.agents) {
      for (const m of xai.models[agent] ?? []) {
        expect(m.group, `${m.id} group`).toBe('grok');
        expect(typeof m.sortOrder, `${m.id} sortOrder`).toBe('number');
      }
    }
  });
});
