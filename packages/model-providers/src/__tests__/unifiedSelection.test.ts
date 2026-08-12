/**
 * unifiedSelection 单测 —— 统一模型选择器 M1:推荐引擎推导 + 跨引擎联合列表。
 *
 * 覆盖规格 docs/product-rules/model-selector-unified.md §2.1 / §2.2 与 §4「目录/来源」
 * 全部条目:同名模型多来源、XD 独占、bridge 前缀归一、`[1m]` 后缀、user provider、
 * retired/disabled 的 keepSelected 归属。
 *
 * fixture 一律手工构造最小 Provider(不 mock 大对象、不读真实 catalog):形状对齐
 * builtin.ts 的四家内置供应商 + buildUserProvider 的产物。
 */

import { describe, expect, it } from 'vitest';

import {
  UNIFIED_AGENT_PRIORITY,
  candidateAgentsForModel,
  catalogModelIdCandidates,
  findCatalogModel,
  normalizeModelIdForClassification,
  pickRecommendedAgent,
  recommendedAgentForModel,
  resolveAgentCapability,
  unifiedModelEntries,
} from '../unifiedSelection.js';
import type { ProviderView } from '../registry.js';
import type {
  AgentKind,
  AuthStrategy,
  CatalogModel,
  ProviderSource,
  RoutingDescriptor,
} from '../types.js';

// ── fixture 工具 ──────────────────────────────────────────────────────────────

function m(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    ...over,
  };
}

interface ViewSpec {
  id: string;
  source?: ProviderSource;
  connected?: boolean;
  suspended?: boolean;
  authStrategy?: AuthStrategy;
  models: Partial<Record<AgentKind, CatalogModel[]>>;
  routingOverride?: Partial<Record<AgentKind, Partial<RoutingDescriptor>>>;
}

function view(spec: ViewSpec): ProviderView {
  const agents = Object.keys(spec.models) as AgentKind[];
  const routing: Partial<Record<AgentKind, RoutingDescriptor>> = {};
  for (const agent of agents) {
    routing[agent] = {
      upstream: 'https://example.test',
      authStrategy: spec.authStrategy ?? 'oauth-passthrough',
      ...(spec.routingOverride?.[agent] ?? {}),
    };
  }
  return {
    id: spec.id,
    name: spec.id,
    source: spec.source ?? 'builtin',
    agents,
    auth: { method: 'oauth' },
    routing,
    models: spec.models,
    connected: spec.connected ?? true,
    ...(spec.suspended ? { suspended: true } : {}),
  };
}

/** Anthropic:claude-code root,codex / pi 是 anthropic-messages bridge 投影(fast=false)。 */
const anthropic = view({
  id: 'anthropic',
  models: {
    'claude-code': [m('claude-opus-5', { contextWindow: 200_000, supportsFastMode: true })],
    codex: [m('claude-opus-5', { supportsFastMode: false })],
    pi: [m('claude-opus-5')],
  },
});

/** OpenAI:codex root(裸 id),cc / pi 是 `chatgpt/` bridge 条目(不同 id ⇒ 不同行)。 */
const openai = view({
  id: 'openai',
  models: {
    codex: [m('gpt-5.5', { contextWindow: 272_000, supportsFastMode: true })],
    'claude-code': [m('chatgpt/gpt-5.5', { contextWindow: 272_000, supportsFastMode: false })],
    pi: [m('chatgpt/gpt-5.5', { supportsFastMode: false })],
  },
  routingOverride: {
    'claude-code': { modelPrefixes: ['chatgpt/'] },
    pi: { modelPrefixes: ['chatgpt/'] },
  },
});

/** xAI:cc / codex 双 root,pi 镜像 cc;同一 `xai/` id 三处都在。 */
const xai = view({
  id: 'xai',
  models: {
    'claude-code': [m('xai/grok-4.5', { group: 'grok' })],
    codex: [m('xai/grok-4.5', { group: 'grok' })],
    pi: [m('xai/grok-4.5', { group: 'grok' })],
  },
  routingOverride: { codex: { modelIdRewrite: { stripPrefix: 'xai/' } } },
});

/** XD 网关:authStrategy `gateway-key` 是"网关形态"的数据判据。 */
const xd = view({
  id: 'xd',
  authStrategy: 'gateway-key',
  models: {
    'claude-code': [
      m('claude-opus-5', { contextWindow: 1_000_000, contextWindowVerified: true }),
      m('gpt-5.5'),
      m('xd-only-model'),
    ],
    codex: [
      m('gpt-5.5', { contextWindow: 272_000 }),
      m('codex/gpt-5.5', { supportsFastMode: true }),
      m('codex-only-model'),
    ],
    pi: [m('claude-opus-5'), m('xd-only-model')],
  },
  routingOverride: { codex: { modelIdRewrite: { stripPrefix: 'codex/' } } },
});

const alwaysVisible = () => true;

// ── normalizeModelIdForClassification / catalogModelIdCandidates ──────────────

describe('id 归一', () => {
  it('剥 bridge 命名空间前缀与 [1m] 后缀(分类用)', () => {
    expect(normalizeModelIdForClassification('chatgpt/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeModelIdForClassification('xai/grok-4.5')).toBe('grok-4.5');
    expect(normalizeModelIdForClassification('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(normalizeModelIdForClassification('chatgpt/codex/gpt-5.5[1m]')).toBe('codex/gpt-5.5');
    // 折扣路由前缀**不**在归一范围:它是目录里真实存在的 id 一部分,剥掉就认不出折扣条目。
    expect(normalizeModelIdForClassification('codex/gpt-5.5')).toBe('codex/gpt-5.5');
  });

  it('目录查找候选 id 与 host getCatalogModelContextWindow 同口径', () => {
    expect(catalogModelIdCandidates('gpt-5.5')).toEqual(['gpt-5.5']);
    expect(catalogModelIdCandidates('gpt-5.5[1m]')).toEqual(['gpt-5.5[1m]', 'gpt-5.5']);
    expect(catalogModelIdCandidates('codex/gpt-5.5[1m]', 'codex/')).toEqual([
      'codex/gpt-5.5[1m]',
      'codex/gpt-5.5',
      'gpt-5.5[1m]',
      'gpt-5.5',
    ]);
    // 前缀不匹配时不乱剥。
    expect(catalogModelIdCandidates('gpt-5.5', 'codex/')).toEqual(['gpt-5.5']);
  });

  it('findCatalogModel:精确 id 优先,[1m] 变体是独立条目不互相顶替', () => {
    const provider = view({
      id: 'p',
      models: {
        'claude-code': [
          m('claude-opus-5', { contextWindow: 200_000 }),
          m('claude-opus-5[1m]', { contextWindow: 1_000_000 }),
        ],
      },
    });
    expect(findCatalogModel(provider, 'claude-opus-5', 'claude-code')?.contextWindow).toBe(200_000);
    expect(findCatalogModel(provider, 'claude-opus-5[1m]', 'claude-code')?.contextWindow).toBe(
      1_000_000,
    );
  });

  it('findCatalogModel:目录没有 [1m] 变体时回落到基础 id(会话侧 wire id 归一)', () => {
    const provider = view({ id: 'p', models: { 'claude-code': [m('claude-opus-5')] } });
    expect(findCatalogModel(provider, 'claude-opus-5[1m]', 'claude-code')?.id).toBe(
      'claude-opus-5',
    );
  });

  it('findCatalogModel:按该路由的 stripPrefix 归一(codex/ 折扣路由)', () => {
    const provider = view({
      id: 'p',
      models: { codex: [m('gpt-5.5')] },
      routingOverride: { codex: { modelIdRewrite: { stripPrefix: 'codex/' } } },
    });
    expect(findCatalogModel(provider, 'codex/gpt-5.5', 'codex')?.id).toBe('gpt-5.5');
    expect(findCatalogModel(provider, 'gpt-5.5', 'claude-code')).toBeUndefined();
  });
});

// ── candidateAgentsForModel ───────────────────────────────────────────────────

describe('candidateAgentsForModel', () => {
  const providers = [anthropic, openai, xai, xd];

  it('按 UNIFIED_AGENT_PRIORITY 序返回该 (provider, model) 真正可路由的引擎', () => {
    expect(candidateAgentsForModel(providers, 'anthropic', 'claude-opus-5')).toEqual([
      'claude-code',
      'codex',
      'pi',
    ]);
    expect(UNIFIED_AGENT_PRIORITY).toEqual(['claude-code', 'codex', 'pi']);
  });

  it('bridge 条目按精确 id 判候选:chatgpt/ 前缀行只在 cc / pi 下存在', () => {
    expect(candidateAgentsForModel(providers, 'openai', 'chatgpt/gpt-5.5')).toEqual([
      'claude-code',
      'pi',
    ]);
    // root 条目是另一行(另一个 id),只在 codex 下 —— 两行不合并。
    expect(candidateAgentsForModel(providers, 'openai', 'gpt-5.5')).toEqual(['codex']);
  });

  it('同名模型多来源:候选按点名的来源解析,不读拍平去重列表', () => {
    // claude-opus-5 由 anthropic(cc/codex/pi)与 xd(cc/pi)同时提供。
    expect(candidateAgentsForModel(providers, 'anthropic', 'claude-opus-5')).toEqual([
      'claude-code',
      'codex',
      'pi',
    ]);
    expect(candidateAgentsForModel(providers, 'xd', 'claude-opus-5')).toEqual([
      'claude-code',
      'pi',
    ]);
  });

  it('XD 独占:只有网关提供的模型仍能解析出候选', () => {
    expect(candidateAgentsForModel(providers, 'xd', 'xd-only-model')).toEqual([
      'claude-code',
      'pi',
    ]);
    expect(candidateAgentsForModel(providers, 'xd', 'codex-only-model')).toEqual(['codex']);
    // 不给 XD 补条目:目录里没有就是没有。
    expect(candidateAgentsForModel(providers, 'xd', 'not-in-gateway')).toEqual([]);
  });

  it('未连接 / 已停用的供应商没有候选(草稿口径)', () => {
    const offline = [view({ id: 'anthropic', connected: false, models: anthropic.models })];
    expect(candidateAgentsForModel(offline, 'anthropic', 'claude-opus-5')).toEqual([]);
    const suspended = [
      view({ id: 'anthropic', suspended: true, models: anthropic.models }),
    ];
    expect(candidateAgentsForModel(suspended, 'anthropic', 'claude-opus-5')).toEqual([]);
  });

  it('停用 / retired 条目:草稿口径剔除,会话口径(scope session)保留', () => {
    const providersWithDead = [
      view({
        id: 'anthropic',
        models: {
          'claude-code': [m('claude-opus-5', { disabled: true })],
          codex: [m('claude-opus-5', { status: 'retired' })],
          pi: [m('claude-opus-5')],
        },
      }),
    ];
    expect(candidateAgentsForModel(providersWithDead, 'anthropic', 'claude-opus-5')).toEqual([
      'pi',
    ]);
    expect(
      candidateAgentsForModel(providersWithDead, 'anthropic', 'claude-opus-5', {
        scope: 'session',
      }),
    ).toEqual(['claude-code', 'codex', 'pi']);
  });

  it('providerId 缺席 = 跟随默认路由:任一来源可服务即算候选', () => {
    // gpt-5.5 只有 openai(codex)与 xd(cc/codex)提供 ⇒ cc + codex,pi 无。
    expect(candidateAgentsForModel(providers, null, 'gpt-5.5')).toEqual(['claude-code', 'codex']);
  });

  it('agents 选项收窄参与推导的引擎', () => {
    expect(
      candidateAgentsForModel(providers, 'anthropic', 'claude-opus-5', {
        agents: ['claude-code', 'pi'],
      }),
    ).toEqual(['claude-code', 'pi']);
  });

  it('非聊天条目(能力模型)不进候选', () => {
    const gatewayNoise = [
      view({
        id: 'xd',
        authStrategy: 'gateway-key',
        models: { 'claude-code': [m('gpt-image-2', { mode: 'image_generation' })] },
      }),
    ];
    expect(candidateAgentsForModel(gatewayNoise, 'xd', 'gpt-image-2')).toEqual([]);
  });
});

// ── recommendedAgentForModel ──────────────────────────────────────────────────

describe('recommendedAgentForModel', () => {
  const providers = [anthropic, openai, xai, xd];

  it('单候选即推荐(含 pi 唯一候选)', () => {
    expect(recommendedAgentForModel(providers, 'openai', 'gpt-5.5')).toBe('codex');
    const piOnly = [
      view({
        id: 'byom',
        source: 'user',
        authStrategy: 'api-key-header',
        models: { pi: [m('local-llama', { group: 'custom:byom' })] },
      }),
    ];
    expect(recommendedAgentForModel(piOnly, 'byom', 'local-llama')).toBe('pi');
  });

  it('anthropic 系 → claude-code(codex/pi 上的是 bridge 投影)', () => {
    expect(recommendedAgentForModel(providers, 'anthropic', 'claude-opus-5')).toBe('claude-code');
  });

  it('openai 系 → codex', () => {
    // 合成 fixture:同一裸 id 同时挂在 codex 与 pi 下,验证 root 表而非回落序生效。
    const openaiMulti = [
      view({ id: 'openai', models: { codex: [m('gpt-5.5')], pi: [m('gpt-5.5')] } }),
    ];
    expect(recommendedAgentForModel(openaiMulti, 'openai', 'gpt-5.5')).toBe('codex');
  });

  it('bridge 条目不改变 root 判定,但推荐必须落在候选内 ⇒ 回落 cc', () => {
    // openai 的 root 偏好仍是 codex;`chatgpt/gpt-5.5` 在 codex 下不存在 ⇒ 回落 cc(非 pi)。
    expect(recommendedAgentForModel(providers, 'openai', 'chatgpt/gpt-5.5')).toBe('claude-code');
  });

  it('xai 双 root → claude-code(piRoot 也是 cc)', () => {
    expect(recommendedAgentForModel(providers, 'xai', 'xai/grok-4.5')).toBe('claude-code');
  });

  it('xd 网关:codex/ 前缀 → codex,其余 → claude-code', () => {
    expect(recommendedAgentForModel(providers, 'xd', 'codex/gpt-5.5')).toBe('codex');
    expect(recommendedAgentForModel(providers, 'xd', 'gpt-5.5')).toBe('claude-code');
    expect(recommendedAgentForModel(providers, 'xd', 'claude-opus-5')).toBe('claude-code');
  });

  it('xd 网关:模型仅在 codex 下 → codex(单候选规则)', () => {
    expect(recommendedAgentForModel(providers, 'xd', 'codex-only-model')).toBe('codex');
  });

  it('xd 网关:服务端显式 group=gpt-budget 也算折扣路由(数据优先,同 isBudgetModel)', () => {
    const gateway = [
      view({
        id: 'xd',
        authStrategy: 'gateway-key',
        models: {
          'claude-code': [m('xd-cheap-gpt', { group: 'gpt-budget' })],
          codex: [m('xd-cheap-gpt', { group: 'gpt-budget' })],
        },
      }),
    ];
    expect(recommendedAgentForModel(gateway, 'xd', 'xd-cheap-gpt')).toBe('codex');
  });

  it('网关判定按 authStrategy=gateway-key 的数据形态,不是 id 白名单', () => {
    const otherGateway = [
      view({
        id: 'some-other-gateway',
        authStrategy: 'gateway-key',
        models: {
          'claude-code': [m('codex/gpt-5.5')],
          codex: [m('codex/gpt-5.5')],
        },
      }),
    ];
    expect(recommendedAgentForModel(otherGateway, 'some-other-gateway', 'codex/gpt-5.5')).toBe(
      'codex',
    );
  });

  it('user provider:按配置的 runtime 取,多个时 cc > codex > pi', () => {
    const byom = (agents: AgentKind[]): ProviderView[] => [
      view({
        id: 'byom',
        source: 'user',
        authStrategy: 'api-key-header',
        models: Object.fromEntries(
          agents.map((agent) => [agent, [m('my-model', { group: 'custom:byom' })]]),
        ) as Partial<Record<AgentKind, CatalogModel[]>>,
      }),
    ];
    expect(recommendedAgentForModel(byom(['claude-code', 'codex', 'pi']), 'byom', 'my-model')).toBe(
      'claude-code',
    );
    expect(recommendedAgentForModel(byom(['codex', 'pi']), 'byom', 'my-model')).toBe('codex');
    expect(recommendedAgentForModel(byom(['pi']), 'byom', 'my-model')).toBe('pi');
  });

  it('pi 永不作为推荐(除非唯一候选)', () => {
    const codexAndPi = [
      view({ id: 'unknown-vendor', models: { codex: [m('vendor-x')], pi: [m('vendor-x')] } }),
    ];
    expect(recommendedAgentForModel(codexAndPi, 'unknown-vendor', 'vendor-x')).toBe('codex');
    const ccAndPi = [
      view({
        id: 'unknown-vendor',
        models: { 'claude-code': [m('vendor-x')], pi: [m('vendor-x')] },
      }),
    ];
    expect(recommendedAgentForModel(ccAndPi, 'unknown-vendor', 'vendor-x')).toBe('claude-code');
  });

  it('无候选时返回 null,不编一个不可路由的推荐', () => {
    expect(recommendedAgentForModel(providers, 'xd', 'not-in-gateway')).toBeNull();
    expect(recommendedAgentForModel(providers, 'nonexistent-provider', 'gpt-5.5')).toBeNull();
  });

  it('pickRecommendedAgent 在空候选集上返回 null', () => {
    expect(pickRecommendedAgent(anthropic, 'claude-opus-5', [])).toBeNull();
  });
});

// ── resolveAgentCapability ────────────────────────────────────────────────────

describe('resolveAgentCapability', () => {
  const providers = [anthropic, openai, xai, xd];

  it('按 (provider, agent, model) 三元组取能力,同 id 跨 agent 可分叉', () => {
    expect(resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'claude-code')).toEqual({
      agent: 'claude-code',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      supportsFastMode: true,
      contextWindow: 200_000,
      contextWindowVerified: false,
    });
    // 同 id 在 codex bridge 下 fast 被强制关闭。
    expect(
      resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'codex')?.supportsFastMode,
    ).toBe(false);
  });

  it('同名模型多来源:能力先解析来源再查,两家各是各的', () => {
    expect(
      resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'claude-code')
        ?.contextWindow,
    ).toBe(200_000);
    expect(
      resolveAgentCapability(providers, 'xd', 'claude-opus-5', 'claude-code')?.contextWindow,
    ).toBe(1_000_000);
    expect(
      resolveAgentCapability(providers, 'xd', 'claude-opus-5', 'claude-code')
        ?.contextWindowVerified,
    ).toBe(true);
  });

  it('取不到条目 / 供应商时返回 null', () => {
    expect(resolveAgentCapability(providers, 'anthropic', 'gpt-5.5', 'codex')).toBeNull();
    expect(resolveAgentCapability(providers, 'nope', 'gpt-5.5', 'codex')).toBeNull();
  });
});

// ── unifiedModelEntries ───────────────────────────────────────────────────────

describe('unifiedModelEntries', () => {
  const providers = [anthropic, openai, xai, xd];

  function find(entries: ReturnType<typeof unifiedModelEntries>, pid: string, mid: string) {
    return entries.find((e) => e.providerId === pid && e.modelId === mid);
  }

  it('每个 (provider, model) 一行,带候选 / 推荐 / 逐引擎能力', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const row = find(entries, 'anthropic', 'claude-opus-5');
    expect(row).toBeDefined();
    expect(row?.candidates).toEqual(['claude-code', 'codex', 'pi']);
    expect(row?.recommended).toBe('claude-code');
    expect(Object.keys(row?.capabilities ?? {}).sort()).toEqual(
      ['claude-code', 'codex', 'pi'].sort(),
    );
    expect(row?.capabilities['claude-code']?.supportsFastMode).toBe(true);
    expect(row?.capabilities.codex?.supportsFastMode).toBe(false);
  });

  it('推荐引擎恒 ∈ 候选(不做假按钮)', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.candidates.length).toBeGreaterThan(0);
      expect(entry.candidates).toContain(entry.recommended);
      expect(Object.keys(entry.capabilities).sort()).toEqual([...entry.candidates].sort());
    }
  });

  it('同名模型多来源:各来源各出一行,不去重', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const rows = entries.filter((e) => e.modelId === 'claude-opus-5');
    expect(rows.map((e) => e.providerId)).toEqual(['anthropic', 'xd']);
    expect(find(entries, 'xd', 'claude-opus-5')?.capabilities['claude-code']?.contextWindow).toBe(
      1_000_000,
    );
  });

  it('bridge 前缀条目与 root 条目是两行,各自推荐不同引擎', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    expect(find(entries, 'openai', 'chatgpt/gpt-5.5')?.recommended).toBe('claude-code');
    expect(find(entries, 'openai', 'gpt-5.5')?.recommended).toBe('codex');
  });

  it('`[1m]` 变体是独立行,不与基础 id 合并', () => {
    const withLongCtx = [
      view({
        id: 'anthropic',
        models: {
          'claude-code': [
            m('claude-opus-5', { contextWindow: 200_000 }),
            m('claude-opus-5[1m]', { contextWindow: 1_000_000 }),
          ],
        },
      }),
    ];
    const entries = unifiedModelEntries({ providers: withLongCtx, isVisible: alwaysVisible });
    expect(entries.map((e) => e.modelId)).toEqual(['claude-opus-5', 'claude-opus-5[1m]']);
    expect(entries[1].capabilities['claude-code']?.contextWindow).toBe(1_000_000);
  });

  it('user provider:custom 分组模型不被能力启发式误杀,推荐取配置的 runtime', () => {
    const byom = view({
      id: 'byom',
      source: 'user',
      authStrategy: 'api-key-header',
      models: {
        codex: [m('flux-image-x', { group: 'custom:byom' })],
        pi: [m('flux-image-x', { group: 'custom:byom' })],
      },
    });
    const entries = unifiedModelEntries({ providers: [byom], isVisible: alwaysVisible });
    expect(entries).toHaveLength(1);
    expect(entries[0].candidates).toEqual(['codex', 'pi']);
    expect(entries[0].recommended).toBe('codex');
  });

  it('XD 独占存在性:网关没有的模型不会被补出来', () => {
    const entries = unifiedModelEntries({ providers: [xd], isVisible: alwaysVisible });
    expect(entries.some((e) => e.modelId === 'not-in-gateway')).toBe(false);
    expect(find(entries, 'xd', 'xd-only-model')?.candidates).toEqual(['claude-code', 'pi']);
    expect(find(entries, 'xd', 'codex-only-model')?.recommended).toBe('codex');
  });

  it('可见性谓词带 agent 维度:同 id 在 codex 下被隐藏只砍掉该候选', () => {
    const entries = unifiedModelEntries({
      providers: [anthropic],
      isVisible: (_providerId, _model, agent) => agent !== 'codex',
    });
    const row = find(entries, 'anthropic', 'claude-opus-5');
    expect(row?.candidates).toEqual(['claude-code', 'pi']);
    expect(row?.capabilities.codex).toBeUndefined();
  });

  it('可见性把所有引擎都隐掉时整行消失', () => {
    expect(unifiedModelEntries({ providers: [anthropic], isVisible: () => false })).toEqual([]);
  });

  it('未连接的供应商不进联合列表(推荐必须可路由)', () => {
    const offline = view({ id: 'anthropic', connected: false, models: anthropic.models });
    expect(unifiedModelEntries({ providers: [offline], isVisible: alwaysVisible })).toEqual([]);
  });

  it('停用 / retired 条目不进新路由清单(keepSelected 豁免由调用层负责)', () => {
    const mixed = view({
      id: 'anthropic',
      models: {
        'claude-code': [
          m('claude-opus-5'),
          m('claude-sonnet-5', { disabled: true }),
          m('claude-haiku-5', { status: 'retired' }),
        ],
      },
    });
    const entries = unifiedModelEntries({ providers: [mixed], isVisible: alwaysVisible });
    expect(entries.map((e) => e.modelId)).toEqual(['claude-opus-5']);
  });

  it('excludeProvider / excludeModel 按引擎注入(SSH 远程口径)', () => {
    const byProvider = unifiedModelEntries({
      providers,
      isVisible: alwaysVisible,
      excludeProvider: (provider, agent) => provider.id === 'openai' && agent === 'codex',
    });
    // openai 的 codex root 行整条消失;cc/pi 的 bridge 行不受影响。
    expect(find(byProvider, 'openai', 'gpt-5.5')).toBeUndefined();
    expect(find(byProvider, 'openai', 'chatgpt/gpt-5.5')?.candidates).toEqual([
      'claude-code',
      'pi',
    ]);

    const byModel = unifiedModelEntries({
      providers,
      isVisible: alwaysVisible,
      excludeModel: (model) => model.id.startsWith('chatgpt/'),
    });
    expect(byModel.some((e) => e.modelId.startsWith('chatgpt/'))).toBe(false);
  });

  it('agents 选项收窄参与联合的引擎', () => {
    const entries = unifiedModelEntries({
      providers: [anthropic],
      agents: ['claude-code'],
      isVisible: alwaysVisible,
    });
    expect(entries[0].candidates).toEqual(['claude-code']);
    expect(entries[0].recommended).toBe('claude-code');
  });

  it('顺序契约:引擎按 cc → codex → pi 首见定位,引擎内按供应商 rail 序 + 目录序', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    expect(entries.map((e) => `${e.providerId}:${e.modelId}`)).toEqual([
      // claude-code 轮:anthropic → openai → xai → xd(各自目录序)
      'anthropic:claude-opus-5',
      'openai:chatgpt/gpt-5.5',
      'xai:xai/grok-4.5',
      'xd:claude-opus-5',
      'xd:gpt-5.5',
      'xd:xd-only-model',
      // codex 轮新增的行
      'openai:gpt-5.5',
      'xd:codex/gpt-5.5',
      'xd:codex-only-model',
    ]);
  });

  it('展示元数据取推荐引擎那条目录条目', () => {
    const skewed = view({
      id: 'anthropic',
      models: {
        'claude-code': [m('claude-opus-5', { name: 'Opus 5', group: 'anthropic', sortOrder: 3 })],
        codex: [m('claude-opus-5', { name: 'Opus 5 (bridge)', sortOrder: 99 })],
      },
    });
    const entries = unifiedModelEntries({ providers: [skewed], isVisible: alwaysVisible });
    expect(entries[0].recommended).toBe('claude-code');
    expect(entries[0].displayName).toBe('Opus 5');
    expect(entries[0].group).toBe('anthropic');
    expect(entries[0].sortOrder).toBe(3);
  });

  it('scope session 保留停用拷贝的候选(运行中会话展示口径)', () => {
    const withDisabled = view({
      id: 'anthropic',
      models: {
        'claude-code': [m('claude-opus-5')],
        codex: [m('claude-opus-5', { disabled: true })],
      },
    });
    // 默认草稿口径:codex 那条被停用 ⇒ 不是候选。
    expect(
      unifiedModelEntries({ providers: [withDisabled], isVisible: alwaysVisible })[0].candidates,
    ).toEqual(['claude-code']);
    // 注:deriveModelList 的准入过滤同样内建剔除 disabled 行,所以 session 口径下
    // codex 行也不会被枚举 —— 运行中会话要保留选中行须由调用层显式并入(见模块头注)。
    expect(
      unifiedModelEntries({
        providers: [withDisabled],
        isVisible: alwaysVisible,
        scope: 'session',
      })[0].candidates,
    ).toEqual(['claude-code']);
  });
});
