/**
 * 测试价值
 * - 生产入口与可观察结果：effectiveModelGroupsConfig(设置页、选择器、伙伴、接替读到的那份配置)——哪些供应商自动合成一条
 *   供应商路由、每个模型由哪些成员提供；再把展开出来的路由交给 pickModelGroupCandidate 与 computeModelGroupSwitchOffer，
 *   看开任务选谁、出问题时换到谁并带着什么思考深度。
 * - 规则依据：2026-11-24 用户裁决「按供应商聚合」(shared/modelGroups.ts 的 ModelGroupSourceRoute)；
 *   docs/product-rules/model-groups.md §4.5「出问题时自动换来源」对每条路由生效。
 * - 现有覆盖缺口：pick.test.ts、switchOffer.test.ts 只用手写的按模型路由；供应商路由的合成与展开没有测试，
 *   展开出来的路由能不能被接替认出来也没有。
 * - 最小失败输入：同一家只连了一个供应商却合成了路由；转接多家的付费入口被自动合进去；组织下发的连接把模型写成
 *   「byok-连接名/模型」、转接入口写成「厂商/模型」时与订阅里的同一个模型对不上；隐藏、改选法、关掉自动换来源没有落到展开出来的路由上；
 *   接替时把思考深度退回默认档。
 * - tier：unit，纯函数与注入依赖，不读文件、不启动 Electron。
 * - 实测耗时：单独运行约 1 秒（pnpm exec vitest run src/main/model-groups/__tests__/sourceRoutes.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  modelGroupAutoSwitchFor,
  modelGroupCandidateKey,
  type ModelGroupCandidate,
  type ModelGroupsConfig,
} from '../../../shared/modelGroups.js';
import { pickModelGroupCandidate } from '../pick.js';
import { effectiveModelGroupsConfig } from '../sourceRoutes.js';
import { computeModelGroupSwitchOffer } from '../switchOffer.js';

const view = (id: string, name: string, agent: string, modelIds: string[], extra: Record<string, unknown> = {}) => ({
  id, name, source: 'builtin', agents: [agent], auth: { method: 'api-key' }, connected: true, routing: { [agent]: {} },
  models: { [agent]: modelIds.map((modelId, sortOrder) => ({
    id: modelId, name: modelId.split('/').pop()!.toUpperCase(), group: 'gpt', sortOrder, contextWindow: 200_000,
    efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', supportsFastMode: true,
  })) },
  ...extra,
}) as unknown as ProviderView;

// 订阅(内置 OpenAI)、组织下发的同一家连接、转接多家的付费入口、另一家。
const SUBSCRIPTION = view('openai', 'OpenAI', 'codex', ['gpt-6-luna', 'gpt-5.5']);
const ORGANIZATION = view('byok-1', 'OpenAI-Codex', 'codex', ['byok-codex/gpt-6-luna'], { source: 'organization', logoKind: 'openai-spectrum' });
// 转接入口把模型写成「厂商/模型」。
const GATEWAY = view('xd', 'Cindy AI', 'codex', ['openai/gpt-6-luna'], { logoKind: 'xd' });
const OTHER = view('anthropic', 'Anthropic', 'claude-code', ['claude-opus-5']);
const AGENTS = ['claude-code', 'codex', 'pi'];

const effective = (stored: ModelGroupsConfig, views: ProviderView[]) =>
  effectiveModelGroupsConfig(stored, { views, agents: AGENTS, available: () => true });
const childrenOf = (config: ModelGroupsConfig, parentId: string) => config.routes.filter((route) => route.parent?.id === parentId);
const sources = (candidates: readonly ModelGroupCandidate[]) => candidates.map((item) => `${item.providerId}:${item.model}`);

describe('provider routes', () => {
  // 2026-11-25 用户反馈：自动合好的路由选了「按顺序」「按权重」，却没有地方调先后和权重。成员是谁仍自动定，
  // 用户排的先后、填的权重、暂停的成员单独存，合成时按它来，并带进每个模型展开出的路由。
  // 失效后果：调了不生效，或调过之后新连上的成员不见了。最小输入：同一家两个连接，存的顺序与连接顺序相反。
  it('keeps the order, weight and pause the user set on an automatic route, and still adds new members', () => {
    const config = effective({ routes: [], autoStrategy: { 'auto:openai': 'weighted' },
      autoSources: { 'auto:openai': [{ providerId: 'byok-1', weight: 5 }, { providerId: 'gone' }] } },
    [GATEWAY, SUBSCRIPTION, ORGANIZATION, OTHER]);
    // 存的顺序在前(已经不在的那个不出现)，没排过的成员跟在后面。
    expect(config.sourceRoutes?.[0].sources).toEqual([{ providerId: 'byok-1', weight: 5 }, { providerId: 'openai' }]);
    const shared = childrenOf(config, 'auto:openai').find((route) => route.candidates.length === 2)!;
    expect(shared.candidates.map((candidate) => [candidate.providerId, candidate.weight ?? 1])).toEqual([['byok-1', 5], ['openai', 1]]);
    const paused = effective({ routes: [], autoSources: { 'auto:openai': [{ providerId: 'openai', off: true }] } }, [GATEWAY, SUBSCRIPTION, ORGANIZATION, OTHER]);
    expect(paused.sourceRoutes?.[0].sources).toEqual([{ providerId: 'openai', off: true }, { providerId: 'byok-1' }]);
    expect(childrenOf(paused, 'auto:openai').every((route) => route.candidates.filter((candidate) => candidate.providerId === 'openai').every((candidate) => candidate.off === true))).toBe(true);
  });

  it('combines providers of one brand automatically and expands the route per model', () => {
    const own = { id: 'mine', name: 'Mine', strategy: 'order' as const, candidates: [] };
    const config = effective({ routes: [own] }, [GATEWAY, SUBSCRIPTION, ORGANIZATION, OTHER]);
    // 付费入口与只连了一个的那一家都不自动合。
    expect(config.sourceRoutes).toEqual([{
      id: 'auto:openai', name: 'OpenAI', strategy: 'expiring', auto: true,
      sources: [{ providerId: 'openai' }, { providerId: 'byok-1' }],
    }]);
    // 用户排的路由在前；展开出来的每条都指回那条供应商路由。
    expect(config.routes[0]).toEqual(own);
    const children = childrenOf(config, 'auto:openai');
    expect(children.every((route) => route.parent?.name === 'OpenAI' && route.strategy === 'expiring')).toBe(true);
    // 两家都有的模型有两个来源(组织连接的「byok-连接名/」前缀不算模型的一部分)；只有订阅有的只有一个来源。
    expect(children.map((route) => sources(route.candidates))).toEqual([
      ['openai:gpt-6-luna', 'byok-1:byok-codex/gpt-6-luna'],
      ['openai:gpt-5.5'],
    ]);
  });

  // 2026-11-25 用户反馈：两个朋友各分享了一个 Claude，合不到一起。分享各是各的账号，即使供应商同名也都是成员。
  it('combines the same provider shared by two people, with each share as its own member', () => {
    const shared = view('anthropic', 'Anthropic', 'claude-code', ['claude-opus-5']);
    const config = effectiveModelGroupsConfig({ routes: [] }, {
      views: [{ ...OTHER, connected: false } as ProviderView], agents: AGENTS, available: () => true,
      remote: new Map([['share:a', [shared]], ['share:b', [shared]]]),
    });
    expect(config.sourceRoutes).toEqual([{
      id: 'auto:anthropic', name: 'Anthropic', strategy: 'expiring', auto: true,
      sources: [{ providerId: 'anthropic', agentDeviceId: 'share:a' }, { providerId: 'anthropic', agentDeviceId: 'share:b' }],
    }]);
    expect(childrenOf(config, 'auto:anthropic').map((route) => route.candidates.map((item) => item.agentDeviceId))).toEqual([['share:a', 'share:b']]);
  });

  it('drops the automatic route once fewer than two providers of the brand are connected', () => {
    const config = effective({ routes: [] }, [SUBSCRIPTION, { ...ORGANIZATION, connected: false } as ProviderView, GATEWAY]);
    expect(config.sourceRoutes).toBeUndefined();
    expect(config.routes).toEqual([]);
  });

  it('applies what the user changed on an automatic route to every route it expands into', () => {
    const config = effective({
      routes: [], hiddenAuto: ['auto:openai'], autoStrategy: { 'auto:openai': 'order' }, autoSwitchOff: ['auto:openai'],
    }, [SUBSCRIPTION, ORGANIZATION]);
    expect(config.sourceRoutes?.[0]).toMatchObject({ hidden: true, strategy: 'order', autoSwitch: false });
    const children = childrenOf(config, 'auto:openai');
    expect(children.map((route) => [route.hidden, route.strategy, route.autoSwitch])).toEqual([[true, 'order', false], [true, 'order', false]]);
    expect(modelGroupAutoSwitchFor(config, { type: 'route', id: children[0].id })).toBe(false);
  });

  it('expands a route the user combined by hand, across brands, keeping a member the user turned off', () => {
    const config = effective({
      routes: [],
      sourceRoutes: [{ id: 'combo', name: 'GPT anywhere', strategy: 'order', effort: 'high', sources: [{ providerId: 'xd', off: true }, { providerId: 'openai' }] }],
    }, [GATEWAY, SUBSCRIPTION]);
    const [shared, subscriptionOnly] = childrenOf(config, 'combo');
    expect(shared).toMatchObject({ name: 'GPT-6-LUNA', strategy: 'order', effort: 'high', parent: { id: 'combo', name: 'GPT anywhere' } });
    // 「openai/gpt-6-luna」与订阅里的「gpt-6-luna」是同一个模型：两个成员都在这一条里。
    expect(shared.candidates.map((item) => [item.providerId, item.off === true])).toEqual([['xd', true], ['openai', false]]);
    expect(sources(subscriptionOnly.candidates)).toEqual(['openai:gpt-5.5']);
  });

  it('starts a task on the member the strategy picks and, when it fails, moves to the other member with the same effort and Fast', async () => {
    const config = effective({ routes: [] }, [SUBSCRIPTION, ORGANIZATION]);
    const child = childrenOf(config, 'auto:openai')[0];
    const facts = child.candidates.map(() => ({ available: true, modelName: 'GPT-6-LUNA', sourceName: 'x', windows: null }));
    // 新任务：两个成员都能用、都读不到额度时取列表里的第一个(订阅)。
    const picked = pickModelGroupCandidate(child, facts, { now: 0 });
    expect(picked.index).toBe(0);

    const first = child.candidates[0];
    const offerFor = (stored: ModelGroupsConfig) => computeModelGroupSwitchOffer({
      readBinding: () => ({ selection: { type: 'route', id: child.id }, pickedKey: modelGroupCandidateKey(first) }) as never,
      readSession: async () => ({ source: 'desktop', agentKind: first.agentKind, providerId: first.providerId, model: first.model }),
      isShared: () => false,
      hasGoal: async () => false,
      config: () => stored,
      // 与真实解析同一约定：思考深度与 Fast 只在那个成员支持时带回来。
      candidateFacts: async (route, context) => route.candidates.map((_, index) => ({
        ...facts[index], ...(context?.effort ? { effort: context.effort } : {}), ...(context?.fastMode ? { fastMode: context.fastMode } : {}),
      })),
      now: () => 0,
    }, 'session-1', {
      visited: new Set(), accountUnavailable: true, recordUnavailable: () => undefined,
      current: { agentKind: first.agentKind, providerId: first.providerId, model: first.model, effort: 'high', fastMode: true },
    });
    await expect(offerFor(config)).resolves.toMatchObject({
      groupName: 'OpenAI', providerId: 'byok-1', model: 'byok-codex/gpt-6-luna', effort: 'high', fastMode: true,
    });
    // 用户关掉了这条供应商路由的「出问题时自动换来源」：不接替。
    await expect(offerFor(effective({ routes: [], autoSwitchOff: ['auto:openai'] }, [SUBSCRIPTION, ORGANIZATION]))).resolves.toBeNull();
  });
});
