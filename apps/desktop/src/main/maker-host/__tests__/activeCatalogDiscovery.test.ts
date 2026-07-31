/**
 * active-catalog 的 discovered augment 单测 —— 验证同一份 Codex 快照同时投影原生 Codex 与
 * Claude bridge:新 id 被加入、名称/排序同源、legacy 静态 id first-wins、空/清空安全。
 *
 * 2026-07-19 统一重构后 bundled 的 openai 是动态清单供应商(零静态模型):codex 注册表
 * 快照就是清单本身;「静态 first-wins」语义只对 legacy 远端目录(仍带静态条目的 v1
 * OSS 文件)生效,用 fixture 模拟。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_CATALOG,
  type AgentKind,
  type Catalog,
  type CatalogModel,
} from '@cindy/model-providers';

import {
  getActiveCatalog,
  getCindyModelContextWindow,
  getCindyModelEffortBaseline,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
  setDiscoveredCodexModels,
} from '../active-catalog.js';

function openaiIds(agent: 'claude-code' | 'codex'): string[] {
  const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
  return (openai?.models[agent] ?? []).map((m) => m.id);
}

const fake = (id: string, sortOrder = 16.999): CatalogModel => ({
  id,
  name: `Discovered ${id}`,
  group: 'gpt',
  sortOrder,
  contextWindow: 400000,
  efforts: ['low', 'high', 'xhigh'],
  defaultEffort: 'high',
  status: 'active',
  defaultEnabled: true,
});

/** legacy v1 远端目录形态:openai 仍带静态 codex/bridge 条目(过渡期兼容)。 */
function legacyCatalog(): Catalog {
  const legacy = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  const openai = legacy.providers.find((p) => p.id === 'openai');
  if (!openai) throw new Error('fixture missing openai');
  openai.models.codex = [
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      group: 'gpt',
      sortOrder: 20,
      contextWindow: 272000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      status: 'active',
    },
  ];
  openai.models['claude-code'] = [
    {
      id: 'chatgpt/gpt-5.5',
      name: 'GPT-5.5 (ChatGPT 订阅)',
      group: 'gpt',
      sortOrder: 25,
      contextWindow: 123456,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      status: 'active',
    },
  ];
  return legacy;
}

describe('active-catalog discovered augment', () => {
  afterEach(() => {
    // 复位全局状态,避免测试间串扰
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([]);
  });

  it('新 discovered id 同时进入 openai.codex 与 openai.claude-code bridge', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.7')]);
    expect(openaiIds('codex')).toContain('gpt-5.7');
    expect(openaiIds('claude-code')).toContain('chatgpt/gpt-5.7');
  });

  it('bridge 投影剔除 max/ultra:codex 侧保留、claude-code 侧封顶 xhigh(issue #352)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([
      {
        ...fake('gpt-5.6-sol', 17),
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'ultra',
      },
    ]);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const codex = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.6-sol');
    const bridge = (openai?.models['claude-code'] ?? []).find(
      (m) => m.id === 'chatgpt/gpt-5.6-sol',
    );
    // codex 侧完整保留(该模型确实支持 max/ultra)。
    expect(codex?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(codex?.defaultEffort).toBe('ultra');
    // claude-code bridge 侧剔除 max/ultra，默认值随之回落到剩余最高档 xhigh。
    expect(bridge?.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(bridge?.defaultEffort).toBe('xhigh');
  });

  it('动态清单契约:注册表快照即清单本身(bundled 零静态,快照全量呈现)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.7', 17), fake('gpt-5.5', 20)]);
    expect(openaiIds('codex')).toEqual(['gpt-5.7', 'gpt-5.5']);
    expect(openaiIds('claude-code')).toEqual(['chatgpt/gpt-5.7', 'chatgpt/gpt-5.5']);
    // 动态快照决定存在性，且明确返回的运行时能力高于 registry 基线。
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    expect((openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.5')?.contextWindow).toBe(
      400000,
    );
  });

  it('legacy v1 远端目录的静态段被忽略(清单来源唯一化:注册表快照就是全部)', () => {
    setActiveCatalog(legacyCatalog());
    setDiscoveredCodexModels([fake('gpt-5.5')]);
    const ids = openaiIds('codex');
    expect(ids).toEqual(['gpt-5.5']);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const m55 = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.5');
    // 动态快照决定存在性和明确能力；legacy 静态条目不复活。
    expect(m55?.contextWindow).toBe(400000);
  });

  it('paired projection 使用同一纯名称和 sortOrder,且按 sortOrder 稳定排序', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.8', 18), fake('gpt-5.7', 17)]);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const codex = (openai?.models.codex ?? []).find((m) => m.id === 'gpt-5.7');
    const bridge = (openai?.models['claude-code'] ?? []).find((m) => m.id === 'chatgpt/gpt-5.7');
    expect(bridge?.name).toBe(codex?.name);
    expect(bridge?.sortOrder).toBe(codex?.sortOrder);
    expect(bridge?.name).not.toContain('订阅');

    // sortOrder 17 的 5.7 排在 18 的 5.8 之前(与注入顺序无关)。
    expect(openaiIds('codex')).toEqual(['gpt-5.7', 'gpt-5.8']);
    expect(openaiIds('claude-code')).toEqual(['chatgpt/gpt-5.7', 'chatgpt/gpt-5.8']);
  });

  it('legacy v1 远端目录 + 空 discovered → openai 两个 tab 都为空(静态 bridge 不复活)', () => {
    setActiveCatalog(legacyCatalog());
    setDiscoveredCodexModels([]);
    expect(openaiIds('codex')).toEqual([]);
    expect(openaiIds('claude-code')).toEqual([]);
  });

  it('bridge tab 默认隐藏策略:chatgpt/gpt-5.4(-mini)默认收起,其余继承 codex 侧可见性', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([fake('gpt-5.5', 20), fake('gpt-5.4', 21), fake('gpt-5.4-mini', 22)]);
    const openai = getActiveCatalog().providers.find((p) => p.id === 'openai');
    const cc = openai?.models['claude-code'] ?? [];
    expect(cc.find((m) => m.id === 'chatgpt/gpt-5.4')?.defaultEnabled).toBe(false);
    expect(cc.find((m) => m.id === 'chatgpt/gpt-5.4-mini')?.defaultEnabled).toBe(false);
    expect(cc.find((m) => m.id === 'chatgpt/gpt-5.5')?.defaultEnabled).toBe(false);
  });

  it('空 discovered + bundled 零静态 → openai 两个 tab 都为空(不用假数据冒充)', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setDiscoveredCodexModels([]);
    expect(openaiIds('codex')).toEqual([]);
    expect(openaiIds('claude-code')).toEqual([]);
  });
});

/** anthropic 发现条目 fixture(模拟订阅通道返回的家族级命名 + 捕获序 sortOrder)。 */
const anthro = (id: string, name: string, sortOrder: number): CatalogModel => ({
  id,
  name,
  group: 'anthropic',
  sortOrder,
  contextWindow: 1_000_000,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  status: 'active',
});

function anthropicList(agent: AgentKind = 'claude-code'): CatalogModel[] {
  const p = getActiveCatalog().providers.find((x) => x.id === 'anthropic');
  return p?.models[agent] ?? [];
}

function withAnthropicRegistry(models: NonNullable<Catalog['modelRegistry']>['models']): Catalog {
  const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  catalog.modelRegistry = {
    schemaVersion: 1,
    updatedAt: '2026-07-31T00:00:00.000Z',
    models,
  };
  return catalog;
}

describe('anthropic 发现条目的 modelRegistry 元数据基线', () => {
  afterEach(() => {
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([]);
  });

  it('基线统一 Anthropic 名字与排序,新模型不透传 Claude 前缀', () => {
    setActiveCatalog(BUNDLED_CATALOG);
    setAnthropicDiscoveredModels([
      anthro('claude-opus-5', 'Claude Opus 5', 0),
      anthro('claude-sonnet-5', 'Claude Sonnet 5', 1),
      anthro('claude-fable-5', 'Claude Fable 5', 2),
      anthro('claude-opus-4-8', 'Claude Opus 4.8', 3),
      anthro('claude-opus-4-7', 'Claude Opus 4.7', 4),
      anthro('claude-sonnet-4-6', 'Claude Sonnet 4.6', 5),
      anthro('claude-opus-4-6', 'Claude Opus 4.6', 6),
      anthro('claude-opus-4-5', 'Claude Opus 4.5', 7),
      anthro('claude-haiku-4-5', 'Claude Haiku 4.5', 8),
      anthro('claude-sonnet-4-5', 'Claude Sonnet 4.5', 9),
    ]);
    expect(anthropicList().map((m) => [m.id, m.name])).toEqual([
      ['claude-opus-5', 'Opus 5'],
      ['claude-fable-5', 'Fable 5'],
      ['claude-opus-4-8', 'Opus 4.8'],
      ['claude-opus-4-7', 'Opus 4.7'],
      ['claude-opus-4-6', 'Opus 4.6'],
      ['claude-opus-4-5', 'Opus 4.5'],
      ['claude-sonnet-5', 'Sonnet 5'],
      ['claude-sonnet-4-6', 'Sonnet 4.6'],
      ['claude-sonnet-4-5', 'Sonnet 4.5'],
      ['claude-haiku-4-5', 'Haiku 4.5'],
    ]);
    expect(anthropicList('codex')).toEqual(
      anthropicList('claude-code').map((model) => ({
        ...model,
        supportsFastMode: false,
      })),
    );
    expect(
      Object.fromEntries(
        [
          'claude-fable-5',
          'claude-opus-5',
          'claude-opus-4-8',
          'claude-opus-4-7',
          'claude-opus-4-6',
          'claude-opus-4-5',
          'claude-sonnet-5',
          'claude-sonnet-4-6',
          'claude-sonnet-4-5',
          'claude-haiku-4-5',
        ].map((id) => [id, getCindyModelEffortBaseline(id)]),
      ),
    ).toEqual({
      'claude-fable-5': {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      'claude-opus-5': {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      'claude-opus-4-8': {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      'claude-opus-4-7': {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      'claude-opus-4-6': {
        efforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'high',
      },
      'claude-opus-4-5': {
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
      'claude-sonnet-5': {
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
      'claude-sonnet-4-6': {
        efforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'high',
      },
      'claude-sonnet-4-5': {
        efforts: [],
        defaultEffort: null,
      },
      'claude-haiku-4-5': {
        efforts: [],
        defaultEffort: null,
      },
    });
    expect(anthropicList().find((m) => m.id === 'claude-opus-4-5')?.defaultEnabled).toBe(false);
    expect(anthropicList().find((m) => m.id === 'claude-sonnet-4-5')?.defaultEnabled).toBe(false);
  });

  it('active overlay 不覆盖能力;发现模块可单独读取 effort 基线', () => {
    setActiveCatalog(
      withAnthropicRegistry([
        {
          id: 'anthropic/claude-known',
          name: 'Known Pro',
          defaultEnabled: false,
          contextWindow: 123,
          efforts: ['max'],
          defaultEffort: 'max',
          routes: [
            {
              providerId: 'anthropic',
              modelId: 'claude-known',
              agents: ['claude-code'],
            },
          ],
        },
      ]),
    );
    setAnthropicDiscoveredModels([
      anthro('claude-known', 'known raw', 0),
      anthro('claude-unknown', 'Unknown Raw', 1),
    ]);
    const known = anthropicList().find((m) => m.id === 'claude-known');
    // 展示字段覆盖;active overlay 不直接改能力,避免覆盖上游显式声明。
    expect(known).toMatchObject({
      name: 'Known Pro',
      defaultEnabled: false,
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high'],
    });
    expect(getCindyModelEffortBaseline('claude-known')).toEqual({
      efforts: ['max'],
      defaultEffort: 'max',
    });
    expect(getCindyModelContextWindow('claude-known')).toBe(123);
    expect(anthropicList().find((m) => m.id === 'claude-unknown')?.name).toBe('Unknown Raw');
  });

  it('远端 registry 是完整快照,不会与 bundled 按字段暗中合并', () => {
    setActiveCatalog(
      withAnthropicRegistry([
        {
          id: 'anthropic/claude-sonnet-4-5',
          name: 'Remote Sonnet 4.5',
          routes: [
            {
              providerId: 'anthropic',
              modelId: 'claude-sonnet-4-5',
              agents: ['claude-code'],
            },
          ],
        },
      ]),
    );
    setAnthropicDiscoveredModels([
      anthro('claude-sonnet-4-5', 'Sonnet Raw', 0),
      anthro('claude-opus-5', 'Opus Raw', 1),
    ]);

    expect(anthropicList().find((m) => m.id === 'claude-sonnet-4-5')?.name).toBe(
      'Remote Sonnet 4.5',
    );
    expect(getCindyModelContextWindow('claude-sonnet-4-5')).toBeNull();
    expect(getCindyModelEffortBaseline('claude-sonnet-4-5')).toBeNull();
    expect(getCindyModelContextWindow('claude-opus-5')).toBeNull();
    expect(getCindyModelEffortBaseline('claude-opus-5')).toBeNull();
  });

  it('active 目录未携带 registry 时不存在旁路元数据回落', () => {
    const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
    delete catalog.modelRegistry;
    setActiveCatalog(catalog);
    setAnthropicDiscoveredModels([anthro('claude-fable-5', 'Fable Raw', 0)]);

    expect(anthropicList()[0]?.name).toBe('Fable Raw');
    expect(getCindyModelContextWindow('claude-fable-5')).toBeNull();
    expect(getCindyModelEffortBaseline('claude-fable-5')).toBeNull();
  });
});
