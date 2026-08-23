/**
 * modelPlane.test.ts —— 模型平面收敛(2026-08-02)的 invariant 矩阵:
 * registry presence 实体化 / 生命周期(retired tombstone + keepSelected 豁免)/
 * 表驱动投影(bridge membership 门控、Pi 恒定派生)/ 本地 override(local 永远
 * 最高、addition 复活 retired、perAgent 单点修、dormant patch)/ XD 不可伪造。
 * 全部走真实 active-catalog computeMerged 管线,不 mock 合并逻辑。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_CATALOG,
  buildRegistry,
  deriveModelList,
  type Catalog,
  type CatalogModel,
} from '@cindy/model-providers';

import {
  getActiveCatalog,
  getModelPlaneWarnings,
  setActiveCatalog,
  setAnthropicDiscoveredModels,
  setDiscoveredCodexModels,
  setLocalCatalogOverrides,
  setXaiDiscoveredModels,
  setXdGatewayModels,
} from '../active-catalog.js';
import {
  EMPTY_MODEL_CATALOG_OVERRIDES,
  sanitizeModelCatalogOverrides,
  type ModelCatalogOverrides,
} from '../model-plane/localCatalogOverrides.js';
import { isRegistryTombstoneForConsumer } from '../model-plane/modelPlanePolicy.js';

type RegistryEntries = NonNullable<Catalog['modelRegistry']>['models'];

function baseCatalog(entries?: RegistryEntries, schemaVersion: 1 | 2 = 1): Catalog {
  const catalog = JSON.parse(JSON.stringify(BUNDLED_CATALOG)) as Catalog;
  delete catalog.modelRegistry;
  if (entries) {
    catalog.modelRegistry = {
      schemaVersion,
      updatedAt: '2026-08-01T00:00:00.000Z',
      models: entries,
    };
  }
  return catalog;
}

type RegistryEntry = RegistryEntries[number];

const gpt6Entry = (overrides: Record<string, unknown> = {}): RegistryEntry =>
  ({
    id: 'openai/gpt-6',
    name: 'GPT-6',
    status: 'active',
    group: 'gpt',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    sortOrder: 1,
    routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['claude-code', 'codex'] }],
    ...overrides,
  }) as RegistryEntry;

const grokEntry = (overrides: Record<string, unknown> = {}): RegistryEntry =>
  ({
    id: 'xai/grok-test',
    name: 'Grok Test',
    status: 'active',
    contextWindow: 500_000,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    routes: [{ providerId: 'xai', modelId: 'xai/grok-test', agents: ['claude-code', 'codex'] }],
    ...overrides,
  }) as RegistryEntry;

function models(providerId: string, agent: 'claude-code' | 'codex' | 'pi'): CatalogModel[] {
  const p = getActiveCatalog().providers.find((x) => x.id === providerId);
  return p?.models[agent] ?? [];
}

function overridesOf(raw: unknown): ModelCatalogOverrides {
  return sanitizeModelCatalogOverrides(raw).overrides;
}

afterEach(() => {
  setActiveCatalog(BUNDLED_CATALOG);
  setDiscoveredCodexModels([]);
  setAnthropicDiscoveredModels([]);
  setXaiDiscoveredModels(null);
  setXdGatewayModels([]);
  setLocalCatalogOverrides(EMPTY_MODEL_CATALOG_OVERRIDES);
});

describe('registry presence 实体化', () => {
  it('a loaded legacy Catalog keeps its own xAI fallback membership instead of importing Pi members', () => {
    const expected = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xai');
    if (!expected) throw new Error('bundled catalog missing xai');
    const generatedCatalog = structuredClone(BUNDLED_CATALOG);
    const generatedXai = generatedCatalog.providers.find((provider) => provider.id === 'xai');
    if (!generatedXai) throw new Error('generated fixture missing xai');
    generatedXai.models['claude-code'] = [];
    generatedXai.models.codex = [];
    generatedXai.models.pi = [];
    setActiveCatalog(generatedCatalog);
    expect(models('xai', 'claude-code')).toEqual(expected.models['claude-code']);
    expect(models('xai', 'codex')).toEqual(expected.models.codex);
    expect(models('xai', 'pi').map((model) => model.id)).toEqual(
      expected.models['claude-code']?.map((model) => model.id.slice('xai/'.length)),
    );
  });

  it('远端宣告 GPT-6(status+能力自洽)→ 免发现进入 codex root,并自动派生 claude/pi bridge', () => {
    setActiveCatalog(baseCatalog([gpt6Entry()]));
    const codex = models('openai', 'codex').find((m) => m.id === 'gpt-6');
    expect(codex).toMatchObject({
      name: 'GPT-6',
      contextWindow: 400_000,
      contextWindowVerified: true,
      maxOutput: 128_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      status: 'active',
    });
    expect(models('openai', 'claude-code').map((m) => m.id)).toContain('chatgpt/gpt-6');
    expect(models('openai', 'pi').map((m) => m.id)).toContain('chatgpt/gpt-6');
  });

  it('公共 Registry 的 newSessionDefault 不进入 CatalogModel；默认只信区域门控后的 /models', () => {
    setActiveCatalog(baseCatalog([gpt6Entry({ newSessionDefault: ['claude-code', 'codex'] })], 2));

    const codex = models('openai', 'codex').find((m) => m.id === 'gpt-6');
    const claude = models('openai', 'claude-code').find((m) => m.id === 'chatgpt/gpt-6');
    const pi = models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-6');
    expect(codex).toBeDefined();
    expect(claude).toBeDefined();
    expect(pi).toBeDefined();
    expect('newSessionDefault' in codex!).toBe(false);
    expect('newSessionDefault' in claude!).toBe(false);
    expect('newSessionDefault' in pi!).toBe(false);
  });

  it('bridge 在投影后应用目标端 perAgent,随后再执行 effort 硬约束', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({
          contextWindow: 1_000_000,
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'xhigh',
          perAgent: {
            codex: {
              contextWindow: 272_000,
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'high',
            },
            'claude-code': { efforts: ['low', 'medium'], defaultEffort: 'medium' },
          },
        }),
      ]),
    );
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-6')).toMatchObject({
      contextWindow: 272_000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });
    expect(models('openai', 'claude-code').find((m) => m.id === 'chatgpt/gpt-6')).toMatchObject({
      contextWindow: 1_000_000,
      efforts: ['low', 'medium'],
      defaultEffort: 'medium',
    });
    // Pi 没有 wire perAgent，但仍是独立消费端：使用 entry 基线，再执行 bridge 硬约束。
    expect(models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-6')).toMatchObject({
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'xhigh',
    });

    setLocalCatalogOverrides(
      overridesOf({ patches: { 'openai:gpt-6': { base: { contextWindow: 123_000 } } } }),
    );
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-6')?.contextWindow).toBe(123_000);
    expect(models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-6')?.contextWindow).toBe(
      123_000,
    );
  });

  it('同一 OpenAI modelId 的长上下文 entry 只生成 Claude/Pi 独立选择', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ contextWindow: 272_000 }),
        gpt6Entry({
          id: 'openai/gpt-6[1m]',
          name: 'GPT-6 (1M · 高消耗)',
          contextWindow: 1_000_000,
          routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['claude-code'] }],
        }),
      ]),
    );

    expect(models('openai', 'codex').filter((m) => m.id.startsWith('gpt-6'))).toMatchObject([
      { id: 'gpt-6', contextWindow: 272_000 },
    ]);
    for (const agent of ['claude-code', 'pi'] as const) {
      expect(
        models('openai', agent)
          .filter((m) => m.id.startsWith('chatgpt/gpt-6'))
          .map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
      ).toEqual([
        { id: 'chatgpt/gpt-6', name: 'GPT-6', contextWindow: 272_000 },
        {
          id: 'chatgpt/gpt-6[1m]',
          name: 'GPT-6 (1M · 高消耗)',
          contextWindow: 1_000_000,
        },
      ]);
    }
    setLocalCatalogOverrides(
      overridesOf({
        patches: { 'openai:gpt-6[1m]': { base: { contextWindow: 900_000 } } },
      }),
    );
    expect(
      models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-6[1m]')?.contextWindow,
    ).toBe(900_000);
    expect(getModelPlaneWarnings()).toEqual([]);
  });

  it('没有 Registry entry 时 Pi 保留 Codex discovery 的既有字段', () => {
    setActiveCatalog(baseCatalog());
    setDiscoveredCodexModels([
      {
        id: 'gpt-discovered',
        name: 'Discovered GPT',
        contextWindow: 272_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);

    expect(models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-discovered')).toMatchObject({
      contextWindow: 272_000,
      efforts: ['high'],
      defaultEffort: 'high',
    });
  });

  it('status 缺失 = metadata-only,不长实体;retired = tombstone,不长实体', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ status: undefined }),
        gpt6Entry({
          id: 'openai/gpt-old',
          status: 'retired',
          routes: [{ providerId: 'openai', modelId: 'gpt-old', agents: ['codex'] }],
        }),
      ]),
    );
    expect(models('openai', 'codex')).toEqual([]);
  });

  it('能力不完整的 route 单条隔离 + 告警,不拖垮其余', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ efforts: undefined, defaultEffort: undefined }),
        gpt6Entry({
          id: 'openai/gpt-6-mini',
          routes: [{ providerId: 'openai', modelId: 'gpt-6-mini', agents: ['codex'] }],
        }),
      ]),
    );
    expect(models('openai', 'codex').map((m) => m.id)).toEqual(['gpt-6-mini']);
    expect(getModelPlaneWarnings()).toMatchObject([
      { providerId: 'openai', modelId: 'gpt-6', reason: expect.stringContaining('efforts') },
    ]);
  });

  it('非法 effort token 整条隔离并告警,不能静默过滤成固定档模型', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ efforts: ['bogus'], defaultEffort: undefined }),
        gpt6Entry({
          id: 'openai/gpt-6-mini',
          routes: [{ providerId: 'openai', modelId: 'gpt-6-mini', agents: ['codex'] }],
        }),
      ]),
    );
    expect(models('openai', 'codex').map((m) => m.id)).toEqual(['gpt-6-mini']);
    expect(getModelPlaneWarnings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'openai',
          agent: 'codex',
          modelId: 'gpt-6',
          reason: 'route has invalid effort token',
        }),
      ]),
    );
  });

  it('跨 entry 重复占用同一 root route 时 first-wins 并隔离重复项', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry(),
        gpt6Entry({ id: 'openai/duplicate', name: 'Duplicate Registry Entry' }),
      ]),
    );
    expect(models('openai', 'codex').filter((m) => m.id === 'gpt-6')).toHaveLength(1);
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-6')?.name).toBe('GPT-6');
    expect(getModelPlaneWarnings()).toMatchObject([
      { modelId: 'gpt-6', reason: expect.stringContaining('multiple registry entries') },
    ]);
  });

  it('preview→alpha;deprecated 实体化但强制默认隐藏', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ status: 'preview' }),
        gpt6Entry({
          id: 'openai/gpt-5-legacy',
          status: 'deprecated',
          defaultEnabled: true,
          routes: [{ providerId: 'openai', modelId: 'gpt-5-legacy', agents: ['codex'] }],
        }),
      ]),
    );
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-6')?.status).toBe('alpha');
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-5-legacy')).toMatchObject({
      status: 'deprecated',
      defaultEnabled: false,
    });
  });

  it('membership 门控 bridge:route.agents 不含 claude-code → claude bridge 无、pi 恒定有', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['codex'] }] }),
      ]),
    );
    expect(models('openai', 'codex').map((m) => m.id)).toContain('gpt-6');
    expect(models('openai', 'claude-code').map((m) => m.id)).not.toContain('chatgpt/gpt-6');
    expect(models('openai', 'pi').map((m) => m.id)).toContain('chatgpt/gpt-6');
  });

  it('status 缺失只做 metadata overlay,不能用 membership 缩减 discovery 投影', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({
          status: undefined,
          routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['codex'] }],
        }),
      ]),
    );
    setDiscoveredCodexModels([
      {
        id: 'gpt-6',
        name: 'Discovered',
        contextWindow: 1,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);
    expect(models('openai', 'claude-code').map((m) => m.id)).toContain('chatgpt/gpt-6');
  });

  it('显式 presence route 没有 canonical root 时隔离并告警', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({
          routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['claude-code'] }],
        }),
      ]),
    );
    expect(models('openai', 'codex')).toEqual([]);
    expect(getModelPlaneWarnings()).toMatchObject([
      { modelId: 'gpt-6', reason: expect.stringContaining('canonical root') },
    ]);
  });

  it('anthropic membership 门控 codex bridge(fast=false 硬约束);pi 恒定镜像 root', () => {
    setActiveCatalog(
      baseCatalog([
        {
          id: 'anthropic/claude-next',
          name: 'Claude Next',
          status: 'active',
          contextWindow: 1_000_000,
          efforts: ['low', 'high'],
          defaultEffort: 'high',
          supportsFastMode: true,
          routes: [{ providerId: 'anthropic', modelId: 'claude-next', agents: ['claude-code'] }],
        } as RegistryEntry,
      ]),
    );
    expect(models('anthropic', 'claude-code').map((m) => m.id)).toEqual(['claude-next']);
    expect(models('anthropic', 'codex')).toEqual([]);
    expect(models('anthropic', 'pi').map((m) => m.id)).toEqual(['claude-next']);
  });

  it('anthropic codex bridge 应用 perAgent.codex 后仍强制 fast=false', () => {
    setActiveCatalog(
      baseCatalog([
        {
          id: 'anthropic/claude-next',
          name: 'Claude Next',
          status: 'active',
          contextWindow: 1_000_000,
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
          supportsFastMode: true,
          perAgent: {
            codex: {
              efforts: ['low', 'medium'],
              defaultEffort: 'medium',
              supportsFastMode: true,
            },
          },
          routes: [
            {
              providerId: 'anthropic',
              modelId: 'claude-next',
              agents: ['claude-code', 'codex'],
            },
          ],
        } as RegistryEntry,
      ]),
    );
    expect(models('anthropic', 'codex').find((m) => m.id === 'claude-next')).toMatchObject({
      efforts: ['low', 'medium'],
      defaultEffort: 'medium',
      supportsFastMode: false,
    });
  });

  it('Gateway 无模型时 registry 也不能造 XD 实体(xd roots=∅)', () => {
    setActiveCatalog(
      baseCatalog([
        {
          id: 'openai/gpt-6',
          name: 'GPT-6',
          status: 'active',
          contextWindow: 400_000,
          efforts: ['high'],
          defaultEffort: 'high',
          routes: [{ providerId: 'xd', modelId: 'gpt-6', agents: ['claude-code', 'codex'] }],
        } as RegistryEntry,
      ]),
    );
    setXdGatewayModels([]);
    const xd = getActiveCatalog().providers.find((p) => p.id === 'xd');
    for (const list of Object.values(xd?.models ?? {})) expect(list).toEqual([]);
  });

  it('区域门控后的 XD /models Agent 与默认标记原样保留，不跨 Agent 投影', () => {
    setXdGatewayModels([
      {
        id: 'deepseek/deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        contextWindow: 200_000,
        agents: ['claude-code', 'codex', 'pi'],
        newSessionDefault: ['claude-code', 'codex', 'pi'],
        perAgent: {
          'claude-code': { wireProtocol: 'anthropic-messages' },
          codex: { wireProtocol: 'openai-responses' },
          pi: { wireProtocol: 'openai-responses' },
        },
      },
    ]);

    expect(
      models('xd', 'claude-code').find((m) => m.id === 'deepseek/deepseek-v4-pro')
        ?.newSessionDefault,
    ).toEqual(['claude-code', 'codex', 'pi']);
    expect(
      models('xd', 'codex').find((m) => m.id === 'deepseek/deepseek-v4-pro')?.newSessionDefault,
    ).toEqual(['claude-code', 'codex', 'pi']);
    expect(
      models('xd', 'pi').find((m) => m.id === 'deepseek/deepseek-v4-pro')?.newSessionDefault,
    ).toEqual(['claude-code', 'codex', 'pi']);
  });
});

describe('retired tombstone 与 discovery 回补', () => {
  const retiredRegistry = () =>
    baseCatalog([
      gpt6Entry({
        id: 'openai/gpt-dead',
        status: 'retired',
        contextWindow: 300_000,
        perAgent: { codex: { contextWindow: 272_000 } },
        routes: [{ providerId: 'openai', modelId: 'gpt-dead', agents: ['codex'] }],
      }),
    ]);
  const discoveredDead: CatalogModel = {
    id: 'gpt-dead',
    name: 'Dead Model',
    contextWindow: 100_000,
    efforts: ['high'],
    defaultEffort: 'high',
  };

  it('无 discovery 实体时仍可按 root/bridge/Pi 投影图查询 Registry tombstone', () => {
    const registry = retiredRegistry().modelRegistry;
    expect(isRegistryTombstoneForConsumer(registry, 'openai', 'gpt-dead', 'codex')).toBe(true);
    expect(isRegistryTombstoneForConsumer(registry, 'openai', 'chatgpt/gpt-dead', 'pi')).toBe(true);
    // route.agents 未授权 Claude bridge，不能把 root tombstone 扩成不存在的消费端。
    expect(
      isRegistryTombstoneForConsumer(registry, 'openai', 'chatgpt/gpt-dead', 'claude-code'),
    ).toBe(false);
    expect(isRegistryTombstoneForConsumer(registry, 'xd', 'gpt-dead', 'claude-code')).toBe(false);

    const withAlias = baseCatalog([
      gpt6Entry(),
      gpt6Entry({
        id: 'openai/gpt-6[1m]',
        status: 'retired',
        routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['claude-code'] }],
      }),
    ]).modelRegistry;
    expect(
      isRegistryTombstoneForConsumer(withAlias, 'openai', 'chatgpt/gpt-6[1m]', 'pi'),
    ).toBe(true);
    expect(
      isRegistryTombstoneForConsumer(
        withAlias,
        'openai',
        'chatgpt/gpt-6[1m]',
        'claude-code',
      ),
    ).toBe(true);
    expect(isRegistryTombstoneForConsumer(withAlias, 'openai', 'chatgpt/gpt-6', 'pi')).toBe(false);
    expect(
      isRegistryTombstoneForConsumer(withAlias, 'openai', 'chatgpt/gpt-6', 'claude-code'),
    ).toBe(false);
  });

  it('discovery 回补的 retired 条目被标记,标准派生禁止新选择,keepSelected 豁免', () => {
    setActiveCatalog(retiredRegistry());
    setDiscoveredCodexModels([discoveredDead]);
    const entry = models('openai', 'codex').find((m) => m.id === 'gpt-dead');
    expect(entry?.status).toBe('retired');
    expect(models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-dead')).toMatchObject({
      contextWindow: 300_000,
      status: 'retired',
    });

    setLocalCatalogOverrides(
      overridesOf({ patches: { 'openai:gpt-dead': { base: { contextWindow: 123_000 } } } }),
    );
    expect(
      models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-dead')?.contextWindow,
    ).toBe(123_000);

    const views = buildRegistry(getActiveCatalog(), { openai: true });
    const withoutSelection = deriveModelList({ providers: views, agent: 'codex' });
    expect(withoutSelection.map((m) => m.id)).not.toContain('gpt-dead');
    const withSelection = deriveModelList({
      providers: views,
      agent: 'codex',
      keepSelected: { providerId: 'openai', modelId: 'gpt-dead' },
    });
    expect(withSelection.map((m) => m.id)).toContain('gpt-dead');
  });

  it('完整 local addition 显式复活远端 retired;patch 改 status 压不掉 tombstone', () => {
    setActiveCatalog(retiredRegistry());
    setDiscoveredCodexModels([discoveredDead]);
    // patch 尝试洗白 → 无效:retired 复标在 patch 之后。
    setLocalCatalogOverrides(
      overridesOf({ patches: { 'openai:gpt-dead': { base: { status: 'active' } } } }),
    );
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-dead')?.status).toBe('retired');
    // 完整 addition → 复活(整条 local 胜)。
    setLocalCatalogOverrides(
      overridesOf({
        additions: {
          'openai:gpt-dead': {
            agents: ['codex'],
            base: {
              name: 'Dead Model Revived',
              contextWindow: 100_000,
              efforts: ['high'],
              defaultEffort: 'high',
              status: 'active',
            },
          },
        },
      }),
    );
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-dead')).toMatchObject({
      name: 'Dead Model Revived',
      status: 'active',
    });
    expect(models('openai', 'pi').find((m) => m.id === 'chatgpt/gpt-dead')).toMatchObject({
      name: 'Dead Model Revived',
      status: 'active',
      contextWindow: 100_000,
    });
  });
});

describe('本地 override(local 永远最高)', () => {
  it('已有条目仅修改 sortOrder 也立即重排,但 xAI 双 root 保留声明顺序', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({
          id: 'openai/gpt-a',
          status: undefined,
          sortOrder: 20,
          routes: [{ providerId: 'openai', modelId: 'gpt-a', agents: ['codex'] }],
        }),
        gpt6Entry({
          id: 'openai/gpt-b',
          status: undefined,
          sortOrder: 10,
          routes: [{ providerId: 'openai', modelId: 'gpt-b', agents: ['codex'] }],
        }),
      ]),
    );
    setDiscoveredCodexModels([
      { id: 'gpt-a', name: 'A', contextWindow: 1, efforts: [], defaultEffort: null },
      { id: 'gpt-b', name: 'B', contextWindow: 1, efforts: [], defaultEffort: null },
    ]);
    expect(models('openai', 'codex').map((model) => model.id)).toEqual(['gpt-b', 'gpt-a']);

    const xaiOrder = models('xai', 'codex').map((model) => model.id);
    const [firstXai, secondXai] = xaiOrder;
    if (!firstXai || !secondXai) throw new Error('expected at least two bundled xAI models');
    setLocalCatalogOverrides(
      overridesOf({
        patches: {
          'openai:gpt-a': { base: { sortOrder: 1 } },
          'openai:gpt-b': { base: { sortOrder: 30 } },
          [`xai:${firstXai}`]: { base: { sortOrder: 999 } },
          [`xai:${secondXai}`]: { base: { sortOrder: -1 } },
        },
      }),
    );
    expect(models('openai', 'codex').map((model) => model.id)).toEqual(['gpt-a', 'gpt-b']);
    expect(models('xai', 'codex').map((model) => model.id)).toEqual(xaiOrder);
  });

  it('一条 perAgent.codex patch 只修 xAI Codex 档位,claude root 与 Pi 官方目录不动', () => {
    const catalog = baseCatalog([grokEntry()]);
    const xai = catalog.providers.find((provider) => provider.id === 'xai');
    if (!xai) throw new Error('bundled catalog missing xai');
    // Loaded catalogs keep CC/Codex fallback membership; official Pi extras must not leak.
    xai.models.pi = [
      ...(xai.models.pi ?? []),
      {
        id: 'grok-pi-only-fixture',
        name: 'Pi Only Fixture',
        group: 'grok',
        contextWindow: 128_000,
        efforts: ['low'],
        defaultEffort: 'low',
        status: 'active',
      },
    ];
    setActiveCatalog(catalog);
    setLocalCatalogOverrides(
      overridesOf({
        patches: {
          'xai:xai/grok-test': {
            perAgent: { codex: { efforts: ['low', 'medium'], defaultEffort: 'medium' } },
          },
        },
      }),
    );
    expect(models('xai', 'codex').find((m) => m.id === 'xai/grok-test')).toMatchObject({
      efforts: ['low', 'medium'],
      defaultEffort: 'medium',
    });
    const claude = models('xai', 'claude-code').find((m) => m.id === 'xai/grok-test');
    expect(claude).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh'] });
    expect(models('xai', 'pi').find((m) => m.id === 'grok-test')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
    });
    expect(models('xai', 'pi').some((m) => m.id === 'grok-pi-only-fixture')).toBe(false);
  });

  it('本地 perAgent 也在 bridge 目标端生效,且不能写展示/status 字段', () => {
    setActiveCatalog(baseCatalog([gpt6Entry()]));
    setLocalCatalogOverrides(
      overridesOf({
        patches: {
          'openai:gpt-6': {
            perAgent: {
              'claude-code': { efforts: ['low'], defaultEffort: 'low' },
            },
          },
        },
      }),
    );
    expect(models('openai', 'claude-code').find((m) => m.id === 'chatgpt/gpt-6')).toMatchObject({
      efforts: ['low'],
      defaultEffort: 'low',
    });
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-6')).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh'],
    });

    expect(
      sanitizeModelCatalogOverrides({
        patches: {
          'openai:gpt-6': {
            perAgent: { 'claude-code': { status: 'deprecated' } },
          },
        },
      }).invalid,
    ).toContain('patches:openai:gpt-6');
  });

  it('local addition 同 key 整条压过 remote,不做字段混合', () => {
    setActiveCatalog(baseCatalog([gpt6Entry()]));
    setLocalCatalogOverrides(
      overridesOf({
        additions: {
          'openai:gpt-6': {
            agents: ['codex'],
            base: {
              name: 'GPT-6 Local',
              contextWindow: 123_456,
              efforts: ['high'],
              defaultEffort: 'high',
            },
          },
        },
      }),
    );
    const entry = models('openai', 'codex').find((m) => m.id === 'gpt-6');
    expect(entry).toMatchObject({ name: 'GPT-6 Local', contextWindow: 123_456, efforts: ['high'] });
    // remote 的 maxOutput/group 不残留(整条替换)。
    expect(entry?.maxOutput).toBeUndefined();
    expect(entry?.group).toBeUndefined();
  });

  it('本地 membership 与 registry 同义:可关闭/重开 bridge,Pi 仍由 root 恒定派生', () => {
    setActiveCatalog(
      baseCatalog([
        gpt6Entry({ routes: [{ providerId: 'openai', modelId: 'gpt-6', agents: ['codex'] }] }),
      ]),
    );
    setLocalCatalogOverrides(
      overridesOf({
        additions: {
          'openai:gpt-6': {
            agents: ['codex'],
            base: {
              name: 'Local Codex Only',
              contextWindow: 123,
              efforts: ['high'],
              defaultEffort: 'high',
            },
          },
        },
      }),
    );
    expect(models('openai', 'claude-code').map((m) => m.id)).not.toContain('chatgpt/gpt-6');
    expect(models('openai', 'pi').map((m) => m.id)).toContain('chatgpt/gpt-6');

    setLocalCatalogOverrides(
      overridesOf({
        additions: {
          'openai:gpt-6': {
            base: {
              name: 'Local All Consumers',
              contextWindow: 123,
              efforts: ['high'],
              defaultEffort: 'high',
              status: 'preview',
            },
          },
        },
      }),
    );
    expect(models('openai', 'claude-code').map((m) => m.id)).toContain('chatgpt/gpt-6');
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-6')?.status).toBe('alpha');
  });

  it('dormant patch:宿主不存在时静置,discovery 出现当日生效', () => {
    setActiveCatalog(baseCatalog());
    setLocalCatalogOverrides(
      overridesOf({ patches: { 'openai:gpt-future': { base: { name: 'Future Name' } } } }),
    );
    expect(models('openai', 'codex')).toEqual([]);
    setDiscoveredCodexModels([
      { id: 'gpt-future', name: 'raw', contextWindow: 1_000, efforts: [], defaultEffort: null },
    ]);
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-future')?.name).toBe('Future Name');
  });

  it('dormant patch 出现后若与宿主 effort 不自洽,只隔离该 patch 并告警', () => {
    setActiveCatalog(baseCatalog());
    setLocalCatalogOverrides(
      overridesOf({ patches: { 'openai:gpt-future': { base: { efforts: ['low'] } } } }),
    );
    setDiscoveredCodexModels([
      {
        id: 'gpt-future',
        name: 'Future',
        contextWindow: 1_000,
        efforts: ['high'],
        defaultEffort: 'high',
      },
    ]);
    expect(models('openai', 'codex').find((m) => m.id === 'gpt-future')).toMatchObject({
      efforts: ['high'],
      defaultEffort: 'high',
    });
    expect(getModelPlaneWarnings()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'gpt-future',
          reason: expect.stringContaining('defaultEffort'),
        }),
      ]),
    );
  });

  it('本地不能造 XD/未知 provider 实体;patch.status=retired 被隔离', () => {
    const xd = sanitizeModelCatalogOverrides({
      additions: {
        'xd:fake-model': {
          base: { name: 'Fake', contextWindow: 1, efforts: [], defaultEffort: null },
        },
      },
    });
    expect(xd.overrides.additions).toEqual({});
    expect(xd.invalid).toEqual(['additions:xd:fake-model']);
    const tombstone = sanitizeModelCatalogOverrides({
      patches: { 'openai:gpt-6': { base: { status: 'retired' } } },
    });
    expect(tombstone.overrides.patches).toEqual({});
    expect(tombstone.invalid).toEqual(['patches:openai:gpt-6']);
  });

  it('未知字段(defaultEnabled/价格/routing 类)整条隔离,不静默丢字段', () => {
    const result = sanitizeModelCatalogOverrides({
      patches: { 'openai:gpt-6': { base: { defaultEnabled: false } } },
    });
    expect(result.overrides.patches).toEqual({});
    expect(result.invalid).toEqual(['patches:openai:gpt-6']);
  });

  it('未来文件版本与不自洽 efforts patch 都整条隔离', () => {
    expect(
      sanitizeModelCatalogOverrides({
        version: 2,
        patches: { 'openai:gpt-6': { base: { name: 'future' } } },
      }),
    ).toMatchObject({ overrides: EMPTY_MODEL_CATALOG_OVERRIDES, invalid: ['version'] });
    expect(
      sanitizeModelCatalogOverrides({
        version: 1,
        patches: {
          'openai:gpt-6': { base: { efforts: ['low'], defaultEffort: 'high' } },
        },
      }).invalid,
    ).toEqual(['patches:openai:gpt-6']);
  });
});
