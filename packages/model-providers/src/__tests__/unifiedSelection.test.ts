/**
 * unifiedSelection 单测 —— 统一模型选择器 M1:逻辑模型行合并 + wire id 映射 +
 * 推荐引擎推导 + 原生底座排序 + 默认档回落。
 *
 * 覆盖规格 docs/product-rules/model-selector-unified.md §2.1 / §2.2 与 §4「目录/来源」
 * 全部条目:同名模型多来源、XD 独占、bridge 前缀归一(合并)、`[1m]` 后缀(不合并)、
 * user provider、retired/disabled 的 keepSelected 归属。
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
  nativeAgentForProviderModel,
  normalizeModelIdForClassification,
  partitionEntriesByNativeAgent,
  pickRecommendedAgent,
  recommendedAgentForModel,
  resolveAgentCapability,
  resolveWireModelId,
  sortEntriesForAgent,
  unifiedModelEntries,
  unifiedModelKeyId,
  type UnifiedModelEntry,
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

/**
 * OpenAI:codex root(裸 id),cc / pi 是 `chatgpt/` bridge 条目。
 * `gpt-5.6-luna` 复刻 Chris 实测的双行 bug:codex `gpt-5.6-luna` + cc/pi `chatgpt/gpt-5.6-luna`。
 */
const openai = view({
  id: 'openai',
  models: {
    codex: [
      m('gpt-5.6-luna', { name: 'GPT-5.6-Luna', contextWindow: 272_000, supportsFastMode: true }),
    ],
    'claude-code': [
      m('chatgpt/gpt-5.6-luna', {
        name: 'GPT-5.6-Luna (bridge)',
        contextWindow: 272_000,
        supportsFastMode: false,
      }),
    ],
    pi: [m('chatgpt/gpt-5.6-luna', { supportsFastMode: false })],
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

/**
 * 智谱形状(A12 回归):cc 同时上架长上下文变体与标准条目,codex 只有标准条目。
 * `glm-5.2[1m]` 与 `glm-5.2` 是**两件商品**(1M vs 标准窗口),候选推导不许把前者归一成
 * 后者 —— 归一了就会在长上下文那行上摆一个 codex 胶囊,点下去发的却是标准窗口那条。
 */
const zhipu = view({
  id: 'zhipu',
  models: {
    'claude-code': [
      m('glm-5.2[1m]', { contextWindow: 1_000_000 }),
      m('glm-5.2', { contextWindow: 200_000 }),
    ],
    codex: [m('glm-5.2', { contextWindow: 200_000 })],
  },
});

const alwaysVisible = () => true;

function find(entries: readonly UnifiedModelEntry[], pid: string, mid: string) {
  return entries.find((e) => e.providerId === pid && e.modelId === mid);
}

// ── id 归一 ───────────────────────────────────────────────────────────────────

describe('id 归一', () => {
  it('行身份 id 只剥 bridge 命名空间前缀', () => {
    expect(unifiedModelKeyId('chatgpt/gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(unifiedModelKeyId('xai/grok-4.5')).toBe('grok-4.5');
    // `[1m]` 与 `codex/` 保留 —— 它们是独立商品,不是同一模型的壳。
    expect(unifiedModelKeyId('claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(unifiedModelKeyId('codex/gpt-5.5')).toBe('codex/gpt-5.5');
  });

  it('分类归一在行身份之上再剥 [1m]', () => {
    expect(normalizeModelIdForClassification('claude-opus-5[1m]')).toBe('claude-opus-5');
    expect(normalizeModelIdForClassification('chatgpt/codex/gpt-5.5[1m]')).toBe('codex/gpt-5.5');
    expect(normalizeModelIdForClassification('codex/gpt-5.5')).toBe('codex/gpt-5.5');
  });

  it('目录查找候选 id:精确优先,含 bridge 壳与 host 的 [1m]/stripPrefix 口径', () => {
    expect(catalogModelIdCandidates('gpt-5.5')).toEqual([
      'gpt-5.5',
      'chatgpt/gpt-5.5',
      'xai/gpt-5.5',
    ]);
    expect(catalogModelIdCandidates('chatgpt/gpt-5.5')[0]).toBe('chatgpt/gpt-5.5');
    expect(catalogModelIdCandidates('chatgpt/gpt-5.5')).toContain('gpt-5.5');
    expect(catalogModelIdCandidates('gpt-5.5[1m]')).toContain('gpt-5.5');
    expect(catalogModelIdCandidates('codex/gpt-5.5[1m]', 'codex/')).toEqual([
      'codex/gpt-5.5[1m]',
      'chatgpt/codex/gpt-5.5[1m]',
      'xai/codex/gpt-5.5[1m]',
      'codex/gpt-5.5',
      'gpt-5.5[1m]',
      'gpt-5.5',
    ]);
  });

  it('exact 候选表不剥 [1m](候选推导不许落到另一件商品上),bridge / stripPrefix 仍归一', () => {
    expect(catalogModelIdCandidates('gpt-5.5[1m]', undefined, { exact: true })).toEqual([
      'gpt-5.5[1m]',
      'chatgpt/gpt-5.5[1m]',
      'xai/gpt-5.5[1m]',
    ]);
    expect(catalogModelIdCandidates('codex/gpt-5.5[1m]', 'codex/', { exact: true })).toEqual([
      'codex/gpt-5.5[1m]',
      'chatgpt/codex/gpt-5.5[1m]',
      'xai/codex/gpt-5.5[1m]',
      'gpt-5.5[1m]',
    ]);
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

  it('findCatalogModel:目录没有 [1m] 变体时回落基础 id(会话侧 wire id 归一)', () => {
    const provider = view({ id: 'p', models: { 'claude-code': [m('claude-opus-5')] } });
    expect(findCatalogModel(provider, 'claude-opus-5[1m]', 'claude-code')?.id).toBe('claude-opus-5');
  });

  it('findCatalogModel:按该路由的 stripPrefix 归一(codex/ 折扣路由)', () => {
    const provider = view({
      id: 'p',
      models: { codex: [m('gpt-5.5')] },
      routingOverride: { codex: { modelIdRewrite: { stripPrefix: 'codex/' } } },
    });
    expect(findCatalogModel(provider, 'codex/gpt-5.5', 'codex')?.id).toBe('gpt-5.5');
  });

  it('resolveWireModelId:归一化 id → 各引擎真实 wire id', () => {
    expect(resolveWireModelId(openai, 'gpt-5.6-luna', 'codex')).toBe('gpt-5.6-luna');
    expect(resolveWireModelId(openai, 'gpt-5.6-luna', 'claude-code')).toBe('chatgpt/gpt-5.6-luna');
    expect(resolveWireModelId(openai, 'gpt-5.6-luna', 'pi')).toBe('chatgpt/gpt-5.6-luna');
    // 反向也成立:传 bridge wire id 也能定位 root 条目。
    expect(resolveWireModelId(openai, 'chatgpt/gpt-5.6-luna', 'codex')).toBe('gpt-5.6-luna');
    expect(resolveWireModelId(anthropic, 'gpt-5.6-luna', 'codex')).toBeNull();
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

  it('bridge 壳与 root 条目寻址同一逻辑模型,候选是并集', () => {
    expect(candidateAgentsForModel(providers, 'openai', 'gpt-5.6-luna')).toEqual([
      'claude-code',
      'codex',
      'pi',
    ]);
    expect(candidateAgentsForModel(providers, 'openai', 'chatgpt/gpt-5.6-luna')).toEqual([
      'claude-code',
      'codex',
      'pi',
    ]);
  });

  it('同名模型多来源:候选按点名的来源解析,不读拍平去重列表', () => {
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
    expect(candidateAgentsForModel(providers, 'xd', 'not-in-gateway')).toEqual([]);
  });

  it('`codex/` 折扣条目不与同名全价条目合并', () => {
    expect(candidateAgentsForModel(providers, 'xd', 'gpt-5.5')).toEqual(['claude-code', 'codex']);
    expect(candidateAgentsForModel(providers, 'xd', 'codex/gpt-5.5')).toEqual(['codex']);
  });

  it('未连接 / 已停用的供应商没有候选(草稿口径)', () => {
    const offline = [view({ id: 'anthropic', connected: false, models: anthropic.models })];
    expect(candidateAgentsForModel(offline, 'anthropic', 'claude-opus-5')).toEqual([]);
    const suspended = [view({ id: 'anthropic', suspended: true, models: anthropic.models })];
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
    expect(candidateAgentsForModel(providersWithDead, 'anthropic', 'claude-opus-5')).toEqual(['pi']);
    expect(
      candidateAgentsForModel(providersWithDead, 'anthropic', 'claude-opus-5', {
        scope: 'session',
      }),
    ).toEqual(['claude-code', 'codex', 'pi']);
  });

  it('providerId 缺席 = 跟随默认路由:任一来源可服务即算候选', () => {
    expect(candidateAgentsForModel(providers, null, 'gpt-5.5')).toEqual(['claude-code', 'codex']);
    expect(candidateAgentsForModel(providers, null, 'gpt-5.6-luna')).toEqual([
      'claude-code',
      'codex',
      'pi',
    ]);
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

// ── nativeAgentForProviderModel ───────────────────────────────────────────────

describe('nativeAgentForProviderModel(原生底座)', () => {
  it('内置 root 表只标确有主场的:anthropic → cc,openai → codex', () => {
    expect(nativeAgentForProviderModel(anthropic, 'claude-opus-5')).toBe('claude-code');
    expect(nativeAgentForProviderModel(openai, 'gpt-5.6-luna')).toBe('codex');
  });

  it('xai 多 root 全能 → null(无主场,任何视图不降级 —— Chris 2026-08-13 裁决)', () => {
    // 上游给 grok 硬选一个主场会让它在其余引擎视图被错误降到「仅兼容」层;
    // #2572 后 grok 三引擎皆正式成员,主场判定必须留空。
    expect(nativeAgentForProviderModel(xai, 'grok-4.5')).toBeNull();
    expect(nativeAgentForProviderModel(xai, 'xai/grok-4.5')).toBeNull();
  });

  it('原生底座不与候选求交:Claude 模型只在 codex 下可选时 native 仍是 cc', () => {
    const codexOnlyClaude = view({ id: 'anthropic', models: { codex: [m('claude-opus-5')] } });
    expect(nativeAgentForProviderModel(codexOnlyClaude, 'claude-opus-5')).toBe('claude-code');
    // 但推荐仍必须落在候选内。
    expect(recommendedAgentForModel([codexOnlyClaude], 'anthropic', 'claude-opus-5')).toBe('codex');
  });

  it('网关按条目判家族主场:codex/ 折扣与 gpt-* → codex,claude-* → cc,判不出 → null', () => {
    expect(nativeAgentForProviderModel(xd, 'codex/gpt-5.5')).toBe('codex');
    // 2026-08-14:主场是按**模型家族**说的,不随来源变 —— 网关上的 GPT/Claude 行同样
    // 有主场(此前全落 null,推荐走「候选里 cc 优先」回落,产出「GPT 整列显示底座
    // Claude」「cc 掉出候选时 Claude 整列翻成 Codex」两类批量错配,Chris 实测反馈)。
    expect(nativeAgentForProviderModel(xd, 'gpt-5.5')).toBe('codex');
    expect(nativeAgentForProviderModel(xd, 'claude-opus-5')).toBe('claude-code');
    // 家族判不出的(grok / 国产 / 未知)仍是 null:无主场,任何视图不降级(裁决不变)。
    expect(nativeAgentForProviderModel(xd, 'x-ai/grok-4.6')).toBeNull();
    expect(nativeAgentForProviderModel(xd, 'deepseek/deepseek-v4-pro')).toBeNull();
  });

  it('家族与前缀矛盾时(codex/ 前缀 + group:anthropic)按目录 group 判:落 claude-code', () => {
    // 三层优先级(见 nativeAgentForProviderModel 头注):内置 root 表 → 折扣判定 → 厂商家族。
    // 后两层都是 isBudgetModel / groupOf 的「数据优先」契约:目录给了**合法** group 就完全
    // 跟 group 走,`codex/` 前缀只在 group 缺失 / 未知时兜底(否则会出现「显示 budget 徽章
    // 却归入 anthropic 分组」的自相矛盾)。本用例锁的是**现行为**,不是新裁决。
    const conflicted = view({
      id: 'xd',
      models: { 'claude-code': [m('codex/weird-claude', { group: 'anthropic' })] },
    });
    expect(nativeAgentForProviderModel(conflicted, 'codex/weird-claude')).toBe('claude-code');
    // group 拿掉后回到前缀兜底 → codex。
    const noGroup = view({
      id: 'xd',
      models: { 'claude-code': [m('codex/weird-claude')] },
    });
    expect(nativeAgentForProviderModel(noGroup, 'codex/weird-claude')).toBe('codex');
    // 未知 group 值不算数据,同样回到前缀兜底。
    const unknownGroup = view({
      id: 'xd',
      models: { 'claude-code': [m('codex/weird-claude', { group: 'custom:whatever' })] },
    });
    expect(nativeAgentForProviderModel(unknownGroup, 'codex/weird-claude')).toBe('codex');
    // 内置 root 表仍在最上层:同一条目挂在 anthropic 名下时 provider 说了算。
    const builtinRoot = view({
      id: 'anthropic',
      models: { 'claude-code': [m('codex/weird-claude', { group: 'gpt' })] },
    });
    expect(nativeAgentForProviderModel(builtinRoot, 'codex/weird-claude')).toBe('claude-code');
  });

  it('device-link 投影(routing 无 authStrategy)与本地同结果:判定链不依赖 authStrategy', () => {
    // 远程供应商投影会剥掉 routing.authStrategy(执行细节不出被控端,
    // providerListProjection 测试锁)。折扣判定只看条目数据,非折扣一律 null ——
    // 判定链里没有任何依赖 authStrategy 的分支,两端天然同结果
    // (2026-08-13 远程会话实测教训的一般化)。
    const projected = view({
      id: 'xd',
      models: {
        'claude-code': [m('codex/gpt-5.5')],
        codex: [m('codex/gpt-5.5', { supportsFastMode: true })],
      },
    });
    // 夹具默认 authStrategy 非 gateway-key,与投影后的效果一致。
    expect(projected.routing['claude-code']?.authStrategy).not.toBe('gateway-key');
    expect(nativeAgentForProviderModel(projected, 'codex/gpt-5.5')).toBe('codex');
    expect(recommendedAgentForModel([projected], 'xd', 'codex/gpt-5.5')).toBe('codex');
    const projectedPlain = view({
      id: 'xd',
      models: { 'claude-code': [m('gpt-5.5-nonbudget', { group: 'gpt' })] },
    });
    // 与本地 xd 夹具(带 gateway-key)的判定一致:家族判定只看条目数据(group / id 前缀),
    // 投影剥掉 authStrategy 后两端同结果。
    expect(nativeAgentForProviderModel(projectedPlain, 'gpt-5.5-nonbudget')).toBe('codex');
    expect(nativeAgentForProviderModel(xd, 'gpt-5.5')).toBe('codex');
  });

  it('用户自定义供应商没有 root 概念 → null(无主场,不降级)', () => {
    const byom = view({
      id: 'byom',
      source: 'user',
      authStrategy: 'api-key-header',
      models: { codex: [m('my-model', { group: 'custom:byom' })] },
    });
    expect(nativeAgentForProviderModel(byom, 'my-model')).toBeNull();
  });
});

// ── recommendedAgentForModel ──────────────────────────────────────────────────

describe('recommendedAgentForModel', () => {
  const providers = [anthropic, openai, xai, xd];

  it('单候选即推荐(含 pi 唯一候选)', () => {
    expect(recommendedAgentForModel(providers, 'xd', 'codex-only-model')).toBe('codex');
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

  it('openai 系 → codex;合并行下 bridge id 与 root id 同答案', () => {
    expect(recommendedAgentForModel(providers, 'openai', 'gpt-5.6-luna')).toBe('codex');
    expect(recommendedAgentForModel(providers, 'openai', 'chatgpt/gpt-5.6-luna')).toBe('codex');
  });

  it('只有 bridge 壳、root 引擎缺席时回落 cc(不做假按钮,也不落 pi)', () => {
    const bridgeOnly = [
      view({
        id: 'openai',
        models: {
          'claude-code': [m('chatgpt/gpt-legacy')],
          pi: [m('chatgpt/gpt-legacy')],
        },
        routingOverride: {
          'claude-code': { modelPrefixes: ['chatgpt/'] },
          pi: { modelPrefixes: ['chatgpt/'] },
        },
      }),
    ];
    expect(recommendedAgentForModel(bridgeOnly, 'openai', 'gpt-legacy')).toBe('claude-code');
  });

  it('xai 双 root 推荐 claude-code', () => {
    expect(recommendedAgentForModel(providers, 'xai', 'grok-4.5')).toBe('claude-code');
    expect(recommendedAgentForModel(providers, 'xai', 'xai/grok-4.5')).toBe('claude-code');
  });

  it('xd 网关:按家族推荐 —— gpt 系(含 codex/ 折扣)→ codex,claude 系 → claude-code', () => {
    expect(recommendedAgentForModel(providers, 'xd', 'codex/gpt-5.5')).toBe('codex');
    // 2026-08-14 改判:GPT 非折扣行主场也是 codex,推荐随主场(此前落 null 走 cc 优先
    // 回落,整列「底座 Claude」)。
    expect(recommendedAgentForModel(providers, 'xd', 'gpt-5.5')).toBe('codex');
    expect(recommendedAgentForModel(providers, 'xd', 'claude-opus-5')).toBe('claude-code');
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
  });

  it('无候选时返回 null,不编一个不可路由的推荐', () => {
    expect(recommendedAgentForModel(providers, 'xd', 'not-in-gateway')).toBeNull();
    expect(recommendedAgentForModel(providers, 'nonexistent-provider', 'gpt-5.5')).toBeNull();
  });

  it('pickRecommendedAgent 在空候选集上返回 null', () => {
    expect(pickRecommendedAgent(anthropic, 'claude-opus-5', [])).toBeNull();
  });
});

// ── resolveAgentCapability / 默认档回落 ───────────────────────────────────────

describe('resolveAgentCapability', () => {
  const providers = [anthropic, openai, xai, xd];

  it('按 (provider, agent, model) 三元组取能力,带该引擎的 wire id', () => {
    expect(resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'claude-code')).toEqual({
      agent: 'claude-code',
      wireModelId: 'claude-opus-5',
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      defaultEffortSource: 'catalog',
      supportsFastMode: true,
      contextWindow: 200_000,
      contextWindowVerified: false,
    });
    expect(
      resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'codex')?.supportsFastMode,
    ).toBe(false);
  });

  it('归一化 id 查 bridge 引擎时回带 bridge wire id', () => {
    const cap = resolveAgentCapability(providers, 'openai', 'gpt-5.6-luna', 'claude-code');
    expect(cap?.wireModelId).toBe('chatgpt/gpt-5.6-luna');
    expect(cap?.supportsFastMode).toBe(false);
    expect(resolveAgentCapability(providers, 'openai', 'gpt-5.6-luna', 'codex')?.wireModelId).toBe(
      'gpt-5.6-luna',
    );
  });

  it('同名模型多来源:能力先解析来源再查,两家各是各的', () => {
    expect(
      resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'claude-code')?.contextWindow,
    ).toBe(200_000);
    expect(
      resolveAgentCapability(providers, 'xd', 'claude-opus-5', 'claude-code')?.contextWindow,
    ).toBe(1_000_000);
    expect(
      resolveAgentCapability(providers, 'xd', 'claude-opus-5', 'claude-code')?.contextWindowVerified,
    ).toBe(true);
  });

  it('默认档缺省回落 medium(仅当 efforts 含 medium)', () => {
    const p = view({
      id: 'xd',
      authStrategy: 'gateway-key',
      models: {
        'claude-code': [
          m('no-default', { defaultEffort: null }),
          m('no-medium', { efforts: ['low', 'high'], defaultEffort: null }),
          m('not-adjustable', { efforts: [], defaultEffort: null }),
          m('bad-default', { efforts: ['low', 'medium'], defaultEffort: 'ultra' }),
        ],
      },
    });
    const cap = (id: string) => resolveAgentCapability([p], 'xd', id, 'claude-code');
    expect(cap('no-default')?.defaultEffort).toBe('medium');
    expect(cap('no-default')?.defaultEffortSource).toBe('fallback-medium');
    // efforts 不含 medium ⇒ 不硬塞一个不支持的档。
    expect(cap('no-medium')?.defaultEffort).toBeNull();
    expect(cap('no-medium')?.defaultEffortSource).toBe('none');
    // efforts 为空 = 不可调,保持 null。
    expect(cap('not-adjustable')?.defaultEffort).toBeNull();
    // 目录声明了 efforts 里没有的档 ⇒ 按缺省处理,回落 medium。
    expect(cap('bad-default')?.defaultEffort).toBe('medium');
    expect(cap('bad-default')?.defaultEffortSource).toBe('fallback-medium');
  });

  it('目录声明了合法默认档时原样保留,不被 medium 顶掉', () => {
    expect(
      resolveAgentCapability(providers, 'anthropic', 'claude-opus-5', 'claude-code')?.defaultEffort,
    ).toBe('high');
  });

  it('取不到条目 / 供应商时返回 null', () => {
    expect(resolveAgentCapability(providers, 'anthropic', 'gpt-5.5', 'codex')).toBeNull();
    expect(resolveAgentCapability(providers, 'nope', 'gpt-5.5', 'codex')).toBeNull();
  });

  it('efforts 防御性规范升序:任何来源的降序/乱序数组经统一选择路径吐升序(Grok 4.5 反轴回归)', () => {
    // efforts 是外部输入(服务端目录 / 三家 discovery / 用户 override),而消费端(滑杆按
    // 下标画轴、efforts[0]=最低 / at(-1)=最高)契约都是升序 —— capabilityOf 的这道排序是
    // 「任一来源漏排就反轴」整类缺陷的单点防线,必须直接锁在共享路径上,不能只靠 xAI
    // 解析层 / 目录合并层各自的测试(那两层删了排序,这里要能红)。fixture 刻意用非 xAI
    // 的网关来源。
    const p = view({
      id: 'xd',
      authStrategy: 'gateway-key',
      models: {
        'claude-code': [
          m('desc-order', { efforts: ['high', 'medium', 'low'], defaultEffort: 'high' }),
          m('shuffled', { efforts: ['xhigh', 'low', 'high'], defaultEffort: null }),
        ],
      },
    });
    const cap = (id: string) => resolveAgentCapability([p], 'xd', id, 'claude-code');
    expect(cap('desc-order')?.efforts).toEqual(['low', 'medium', 'high']);
    // 排序只动表示,不动语义:目录声明的合法默认档原样保留(低→高轴上 high 落在右端)。
    expect(cap('desc-order')?.defaultEffort).toBe('high');
    expect(cap('desc-order')?.defaultEffortSource).toBe('catalog');
    expect(cap('shuffled')?.efforts).toEqual(['low', 'high', 'xhigh']);
    // 默认档回落判据按集合走(不含 medium → none),与顺序无关。
    expect(cap('shuffled')?.defaultEffort).toBeNull();
    expect(cap('shuffled')?.defaultEffortSource).toBe('none');
  });
});

// ── unifiedModelEntries ───────────────────────────────────────────────────────

describe('unifiedModelEntries', () => {
  const providers = [anthropic, openai, xai, xd];

  it('bridge 壳与 root 条目合并成一行(Chris 实测的双行 bug)', () => {
    const entries = unifiedModelEntries({ providers: [openai], isVisible: alwaysVisible });
    expect(entries).toHaveLength(1);
    const row = entries[0];
    expect(row.modelId).toBe('gpt-5.6-luna');
    expect(row.candidates).toEqual(['claude-code', 'codex', 'pi']);
    expect(row.recommended).toBe('codex');
    expect(row.nativeAgent).toBe('codex');
    // 每个引擎发自己的 wire id。
    expect(row.capabilities.codex?.wireModelId).toBe('gpt-5.6-luna');
    expect(row.capabilities['claude-code']?.wireModelId).toBe('chatgpt/gpt-5.6-luna');
    expect(row.capabilities.pi?.wireModelId).toBe('chatgpt/gpt-5.6-luna');
    // 展示元数据取推荐引擎(codex root)那条。
    expect(row.displayName).toBe('GPT-5.6-Luna');
  });

  it('行能力的 efforts 同样规范升序(user provider 降序数组 —— capabilityOf 的第二个入口)', () => {
    // capabilityOf 只有两个调用方:resolveAgentCapability(浮层实时能力)与本函数的行合成。
    // 两条路径都必须直接锁住排序 —— 只锁一条,另一条把排序改错时不会被发现。
    const byom = view({
      id: 'custom:mine',
      source: 'user',
      models: { codex: [m('my-model', { efforts: ['high', 'low'], defaultEffort: 'low' })] },
    });
    const entries = unifiedModelEntries({ providers: [byom], isVisible: alwaysVisible });
    const row = entries.find((entry) => entry.modelId === 'my-model');
    expect(row?.capabilities.codex?.efforts).toEqual(['low', 'high']);
    expect(row?.capabilities.codex?.defaultEffort).toBe('low');
  });

  it('每个候选都有 wire id,且 wire id 必在该引擎目录里真实存在', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.candidates.length).toBeGreaterThan(0);
      expect(entry.candidates).toContain(entry.recommended);
      expect(Object.keys(entry.capabilities).sort()).toEqual([...entry.candidates].sort());
      const provider = providers.find((p) => p.id === entry.providerId);
      for (const agent of entry.candidates) {
        const wireId = entry.capabilities[agent]?.wireModelId;
        expect(provider?.models[agent]?.some((mm) => mm.id === wireId)).toBe(true);
      }
    }
  });

  it('xai 前缀在三个引擎下 id 相同,合并后仍是一行', () => {
    const entries = unifiedModelEntries({ providers: [xai], isVisible: alwaysVisible });
    expect(entries).toHaveLength(1);
    expect(entries[0].modelId).toBe('grok-4.5');
    expect(entries[0].candidates).toEqual(['claude-code', 'codex', 'pi']);
    for (const agent of entries[0].candidates) {
      expect(entries[0].capabilities[agent]?.wireModelId).toBe('xai/grok-4.5');
    }
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
    expect(entries[1].capabilities['claude-code']?.wireModelId).toBe('claude-opus-5[1m]');
  });

  it('`codex/` 折扣行与全价行不合并', () => {
    const entries = unifiedModelEntries({ providers: [xd], isVisible: alwaysVisible });
    // 两行都是 gpt 家族 → 推荐都是 codex,但仍是两行独立条目(价格不同的两个真实商品)。
    expect(find(entries, 'xd', 'gpt-5.5')?.recommended).toBe('codex');
    expect(find(entries, 'xd', 'codex/gpt-5.5')?.recommended).toBe('codex');
    expect(find(entries, 'xd', 'gpt-5.5')).not.toBe(find(entries, 'xd', 'codex/gpt-5.5'));
  });

  it('同名模型多来源:各来源各出一行,不去重', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const rows = entries.filter((e) => e.modelId === 'claude-opus-5');
    expect(rows.map((e) => e.providerId)).toEqual(['anthropic', 'xd']);
    expect(find(entries, 'xd', 'claude-opus-5')?.capabilities['claude-code']?.contextWindow).toBe(
      1_000_000,
    );
  });

  it('user provider:custom 分组模型不被能力启发式误杀,nativeAgent 无主场', () => {
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
    // BYOM 没有 root 概念 → 无主场(null),在任何引擎视图都不降级。
    expect(entries[0].nativeAgent).toBeNull();
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

  it('隐藏 bridge 壳后合并行只剩 root 引擎,仍是一行', () => {
    const entries = unifiedModelEntries({
      providers: [openai],
      isVisible: (_providerId, model) => !model.id.startsWith('chatgpt/'),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].candidates).toEqual(['codex']);
    expect(entries[0].capabilities.codex?.wireModelId).toBe('gpt-5.6-luna');
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
    // codex root 被排除后,合并行只剩 bridge 引擎,行仍在(不是整行消失)。
    expect(find(byProvider, 'openai', 'gpt-5.6-luna')?.candidates).toEqual(['claude-code', 'pi']);
    expect(find(byProvider, 'openai', 'gpt-5.6-luna')?.recommended).toBe('claude-code');

    const byModel = unifiedModelEntries({
      providers,
      isVisible: alwaysVisible,
      excludeModel: (model) => model.id.startsWith('chatgpt/'),
    });
    expect(find(byModel, 'openai', 'gpt-5.6-luna')?.candidates).toEqual(['codex']);
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
      'openai:gpt-5.6-luna',
      'xai:grok-4.5',
      'xd:claude-opus-5',
      'xd:gpt-5.5',
      'xd:xd-only-model',
      // codex 轮新增的行
      'xd:codex/gpt-5.5',
      'xd:codex-only-model',
    ]);
  });

  it('[1m] 变体不借基础条目蹭候选引擎(智谱形状)', () => {
    // 候选推导:cc 有 `glm-5.2[1m]`,codex 只有 `glm-5.2` → 长上下文行的候选只有 cc。
    expect(candidateAgentsForModel([zhipu], 'zhipu', 'glm-5.2[1m]')).toEqual(['claude-code']);
    expect(candidateAgentsForModel([zhipu], 'zhipu', 'glm-5.2')).toEqual(['claude-code', 'codex']);
    // wire id 解析同口径:codex 下根本没有这条,必须是 null 而不是回落到标准窗口那条。
    expect(resolveWireModelId(zhipu, 'glm-5.2[1m]', 'codex')).toBeNull();
    expect(resolveWireModelId(zhipu, 'glm-5.2[1m]', 'claude-code')).toBe('glm-5.2[1m]');

    const entries = unifiedModelEntries({ providers: [zhipu], isVisible: alwaysVisible });
    expect(find(entries, 'zhipu', 'glm-5.2[1m]')?.candidates).toEqual(['claude-code']);
    expect(find(entries, 'zhipu', 'glm-5.2[1m]')?.capabilities.codex).toBeUndefined();
    expect(find(entries, 'zhipu', 'glm-5.2')?.candidates).toEqual(['claude-code', 'codex']);
  });

  it('付费模型仅在显式展示模式下进入联合列表，并保留锁定状态', () => {
    const gated = view({
      id: 'xd',
      models: {
        'claude-code': [
          m('free-model', { availability: 'available' }),
          m('paid-model', { availability: 'requires_payment' }),
        ],
      },
    });

    expect(
      unifiedModelEntries({ providers: [gated], isVisible: alwaysVisible }).map(
        (entry) => entry.modelId,
      ),
    ).toEqual(['free-model']);

    const visible = unifiedModelEntries({
      providers: [gated],
      isVisible: alwaysVisible,
      includePaymentRequired: true,
    });
    expect(visible.map((entry) => entry.modelId)).toEqual(['free-model', 'paid-model']);
    expect(find(visible, 'xd', 'paid-model')?.availability).toBe('requires_payment');
  });

  it('选中行豁免(keepModel):停用 / retired 的选中条目仍成行,并带上候选与能力', () => {
    const mixed = view({
      id: 'anthropic',
      models: {
        'claude-code': [
          m('claude-opus-5'),
          m('claude-sonnet-5', { disabled: true }),
          m('claude-haiku-5', { status: 'retired' }),
        ],
        codex: [m('claude-haiku-5', { status: 'retired' })],
      },
    });
    // 不传 keepModel:新路由准入照旧把两条挡掉(回归保护)。
    expect(
      unifiedModelEntries({ providers: [mixed], isVisible: alwaysVisible }).map((e) => e.modelId),
    ).toEqual(['claude-opus-5']);

    // 停用条目:会话里正跑着它,行必须留着。
    const withDisabled = unifiedModelEntries({
      providers: [mixed],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-sonnet-5', agent: 'claude-code' },
    });
    const disabledRow = find(withDisabled, 'anthropic', 'claude-sonnet-5');
    expect(disabledRow?.candidates).toEqual(['claude-code']);
    expect(disabledRow?.capabilities['claude-code']?.wireModelId).toBe('claude-sonnet-5');

    // retired 条目 + `providerId: null`(跟随默认路由)同样保得住。
    const withRetired = unifiedModelEntries({
      providers: [mixed],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: null, modelId: 'claude-haiku-5', agent: 'claude-code' },
    });
    // ★ 豁免按 agent 收窄:codex 上那份同 id 副本同样 retired、不可新路由,不许跟着放行 ——
    // 放行的话用户在浮层里把行切到 codex,点下去要么路由错来源、要么直接发不出去。
    expect(find(withRetired, 'anthropic', 'claude-haiku-5')?.candidates).toEqual(['claude-code']);
    expect(find(withRetired, 'anthropic', 'claude-haiku-5')?.capabilities.codex).toBeUndefined();
    // 豁免只作用于点名那一行,不是把整张表的准入放开。
    expect(withRetired.some((e) => e.modelId === 'claude-sonnet-5')).toBe(false);
  });

  it('选中行豁免:kept agent 之外的引擎照常受来源校验(reviewer 场景)', () => {
    // 会话在 codex 上跑一条已 retired 的模型;同一供应商在 cc / pi 下还有同 id 的目录副本,
    // 但它们也已 retired(不可用于新路由)。整行豁免会把 cc / pi 一起放进候选 —— 用户切过去
    // 就路由错来源 / 直接失败。收窄后:行还在(codex 那格是当前运行配置的锚),候选只剩 codex。
    const retiredEverywhere = view({
      id: 'anthropic',
      models: {
        'claude-code': [m('claude-opus-5'), m('claude-haiku-5', { status: 'retired' })],
        codex: [m('claude-haiku-5', { status: 'retired' })],
        pi: [m('claude-haiku-5', { status: 'retired' })],
      },
    });
    const entries = unifiedModelEntries({
      providers: [retiredEverywhere],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-haiku-5', agent: 'codex' },
    });
    const row = find(entries, 'anthropic', 'claude-haiku-5');
    expect(row?.candidates).toEqual(['codex']);
    expect(row?.recommended).toBe('codex');
    expect(Object.keys(row?.capabilities ?? {})).toEqual(['codex']);
  });

  it('kept 判定绑定枚举引擎:其它引擎撞名 wire id 不把行标成 kept(2026-08-17 review)', () => {
    // cc 是 kept agent(当前配置的 wire id 是 'gpt-x');本供应商 codex 恰有一条 id 相同的
    // 目录条目,cc 侧则是桥接壳 'chatgpt/gpt-x'(归一化后合并为同一行)。kept 不绑引擎时,
    // codex 那一轮会把整行点亮,cc 格随之跳过来源校验 —— 当前来源解析对显式来源的短路让
    // 误标暂不可达坏输出,但正确性不该依赖那条短路。绑定后 kept 只能由 cc 自己的行
    // (wire id 恰为 'gpt-x')点亮;本形状下两格照常各自走完校验。
    const collision = view({
      id: 'xd',
      models: {
        'claude-code': [m('chatgpt/gpt-x')],
        codex: [m('gpt-x')],
      },
    });
    const entries = unifiedModelEntries({
      providers: [collision],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: null, modelId: 'gpt-x', agent: 'claude-code' },
    });
    const row = find(entries, 'xd', 'gpt-x');
    expect(row?.candidates).toEqual(['claude-code', 'codex']);
    expect(row?.capabilities['claude-code']?.wireModelId).toBe('chatgpt/gpt-x');
    expect(row?.capabilities.codex?.wireModelId).toBe('gpt-x');
  });

  it('选中行豁免:其它引擎的副本本身可正常路由时,仍是合法候选(反向用例)', () => {
    // 与上一条唯一的差别:cc / pi 的副本是**健康**的。它们靠自己走完准入 + 来源校验进候选,
    // 不需要豁免 —— 收窄豁免不该顺手砍掉真正能用的引擎。
    const healthyElsewhere = view({
      id: 'anthropic',
      models: {
        'claude-code': [m('claude-haiku-5')],
        codex: [m('claude-haiku-5', { status: 'retired' })],
        pi: [m('claude-haiku-5')],
      },
    });
    const entries = unifiedModelEntries({
      providers: [healthyElsewhere],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-haiku-5', agent: 'codex' },
    });
    const row = find(entries, 'anthropic', 'claude-haiku-5');
    expect(row?.candidates).toEqual(['claude-code', 'codex', 'pi']);
    expect(row?.capabilities.codex?.wireModelId).toBe('claude-haiku-5');
  });

  it('选中行豁免:整行只剩 kept agent 一格时,行仍在(条目停用 + 隐藏叠加)', () => {
    // 四类「行会消失」的状态里,枚举得到的那三类(条目 disabled / 目录 retired / 用户隐藏)
    // 叠在一起也必须保住 kept 那一格,且只保那一格。
    const hostile = view({
      id: 'anthropic',
      models: {
        'claude-code': [m('claude-opus-5', { disabled: true })],
        codex: [m('claude-opus-5', { status: 'retired' })],
      },
    });
    const entries = unifiedModelEntries({
      providers: [hostile],
      isVisible: () => false,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(entries.map((e) => e.modelId)).toEqual(['claude-opus-5']);
    expect(entries[0].candidates).toEqual(['claude-code']);
  });

  it('选中行豁免覆盖供应商层:kept 供应商停用 / 断开时并回 rail,行保住且只保 kept 那一格', () => {
    // 2026-08-17 review:此前这两态是记录在案的边界(rail 层整家剔除,keepModel 无从豁免),
    // 现在 rail 对 kept 那一家开口 —— 但只放行点名 wire id × kept 引擎,同家其它模型与
    // 同行其它引擎照常出局(三层过滤各自收口,见 keepModel 头注)。
    const suspended = view({
      id: 'anthropic',
      suspended: true,
      models: {
        // 同家还有一条健康模型 + 同模型的 codex 副本:都不得跟着 kept 并回。
        'claude-code': [m('claude-opus-5'), m('claude-haiku-5')],
        codex: [m('claude-opus-5')],
      },
    });
    const entries = unifiedModelEntries({
      providers: [suspended],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(entries.map((e) => e.modelId)).toEqual(['claude-opus-5']);
    expect(entries[0].candidates).toEqual(['claude-code']);
    expect(Object.keys(entries[0].capabilities)).toEqual(['claude-code']);

    const offline = view({
      id: 'anthropic',
      connected: false,
      models: { 'claude-code': [m('claude-opus-5'), m('claude-haiku-5')] },
    });
    const offlineEntries = unifiedModelEntries({
      providers: [offline],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(offlineEntries.map((e) => e.modelId)).toEqual(['claude-opus-5']);
    expect(offlineEntries[0].candidates).toEqual(['claude-code']);
  });

  it('供应商层并回按显式来源点名:另一家健康来源同 id 各自成行,互不放大', () => {
    // 显式来源(providerId 非 null)被停用、而另一家已连接来源提供同名模型:kept 那一家
    // 仍要并回(用户正在跑的是**那一家**的配置,健康行替代不了它),两行并存 ——
    // 健康行走全套校验,kept 行只有 kept 引擎一格。
    const suspendedA = view({
      id: 'anthropic',
      suspended: true,
      models: { 'claude-code': [m('claude-opus-5')] },
    });
    const healthyB = view({
      id: 'xd',
      models: { 'claude-code': [m('claude-opus-5')] },
    });
    const entries = unifiedModelEntries({
      providers: [suspendedA, healthyB],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(entries.map((e) => e.providerId)).toEqual(['anthropic', 'xd']);
  });

  it('供应商层并回在跟随默认路由(providerId null)时只当无任何健康来源提供该 id 才发生', () => {
    const suspendedA = view({
      id: 'anthropic',
      suspended: true,
      models: { 'claude-code': [m('claude-opus-5')] },
    });
    const healthyB = view({
      id: 'xd',
      models: { 'claude-code': [m('claude-opus-5')] },
    });
    // 有健康来源提供同 id:行本就在(xd),不并回停用的那一家 —— 并回只会多一条点了会
    // 改道的影子行。
    const withHealthy = unifiedModelEntries({
      providers: [suspendedA, healthyB],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: null, modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(withHealthy.map((e) => e.providerId)).toEqual(['xd']);
    // 健康来源也没了:并回停用的那一家,行保住。
    const noneHealthy = unifiedModelEntries({
      providers: [suspendedA],
      isVisible: alwaysVisible,
      scope: 'session',
      keepModel: { providerId: null, modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(noneHealthy.map((e) => e.providerId)).toEqual(['anthropic']);
    expect(noneHealthy[0].candidates).toEqual(['claude-code']);
  });

  it('选中行豁免也松开可见性 override(与 deriveModelList.keepSelected 同约定)', () => {
    const entries = unifiedModelEntries({
      providers: [anthropic],
      isVisible: () => false,
      keepModel: { providerId: 'anthropic', modelId: 'claude-opus-5', agent: 'claude-code' },
    });
    expect(entries.map((e) => e.modelId)).toEqual(['claude-opus-5']);
    // 可见性豁免同样只覆盖 kept agent:被用户隐藏的 codex / pi 副本不跟着回到候选。
    expect(entries[0].candidates).toEqual(['claude-code']);
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
});

// ── 原生底座排序 ──────────────────────────────────────────────────────────────

describe('sortEntriesForAgent(原生底座优先,无主场不降级)', () => {
  const providers = [anthropic, openai, xai, xd];
  /** 新语义的降级判据:只有「主场明确在别处」的行是客串。 */
  const isGuest = (e: UnifiedModelEntry, agent: AgentKind) =>
    e.nativeAgent !== null && e.nativeAgent !== agent;

  it('codex 视图:Claude 系(主场在 cc)降级垫底,GPT 系与无主场行按入参序在前', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const sorted = sortEntriesForAgent(entries, 'codex');
    const guests = entries.filter((e) => isGuest(e, 'codex'));
    expect(guests.length).toBeGreaterThan(0);
    // 客串行整体垫底,组内保持入参序;上组 = 原生 + 无主场,同样保持入参序。
    expect(sorted.slice(sorted.length - guests.length)).toEqual(guests);
    expect(sorted.slice(0, sorted.length - guests.length).every((e) => !isGuest(e, 'codex'))).toBe(
      true,
    );
    // anthropic(主场 cc)原本排首位,codex 视图里让位给 openai 的 GPT 行。
    expect(sorted[0].providerId).toBe('openai');
    expect(entries[0].providerId).toBe('anthropic');
  });

  it('claude 视图:GPT 系(主场在 codex)垫底,Claude 系与无主场行在前', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const sorted = sortEntriesForAgent(entries, 'claude-code');
    expect(sorted[0].modelId).toBe('claude-opus-5');
    const flags = sorted.map((e) => !isGuest(e, 'claude-code'));
    // 非客串(true)全部排在客串(false)之前。
    expect(flags.indexOf(false) === -1 || flags.lastIndexOf(true) < flags.indexOf(false)).toBe(true);
  });

  it('无主场行(xai 三栖)在三个引擎视图都不降级(Chris 2026-08-13 裁决)', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const grok = entries.find((e) => e.providerId === 'xai');
    expect(grok).toBeDefined();
    expect(grok!.nativeAgent).toBeNull();
    for (const agent of ['claude-code', 'codex', 'pi'] as const) {
      const { native } = partitionEntriesByNativeAgent(entries, agent);
      expect(native).toContain(grok!);
    }
  });

  it('组内保持入参顺序(服务端 group/sortOrder 陈列序不被打乱)', () => {
    const entries = unifiedModelEntries({ providers, isVisible: alwaysVisible });
    const { native, compatible } = partitionEntriesByNativeAgent(entries, 'codex');
    const key = (e: UnifiedModelEntry) => `${e.providerId}:${e.modelId}`;
    const order = entries.map(key);
    const nativeOrder = native.map(key);
    const compatOrder = compatible.map(key);
    expect(nativeOrder).toEqual(order.filter((k) => nativeOrder.includes(k)));
    expect(compatOrder).toEqual(order.filter((k) => compatOrder.includes(k)));
  });

  it('排序不做准入过滤:不兼容目标引擎的行由调用方在派生阶段挡', () => {
    const entries = unifiedModelEntries({ providers: [xd], isVisible: alwaysVisible });
    expect(sortEntriesForAgent(entries, 'codex')).toHaveLength(entries.length);
    const codexOnly = unifiedModelEntries({
      providers: [xd],
      agents: ['codex'],
      isVisible: alwaysVisible,
    });
    expect(codexOnly.every((e) => e.candidates.includes('codex'))).toBe(true);
  });
});
