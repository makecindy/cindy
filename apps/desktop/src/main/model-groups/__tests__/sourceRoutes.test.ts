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
 *   接替时把思考深度退回默认档；一家只剩一个连接后，已绑定这条路由的任务找不到路由、接不上剩下的那个。
 * - tier：unit，纯函数与注入依赖，不读文件、不启动 Electron。
 * - 实测耗时：单独运行约 1 秒（pnpm exec vitest run src/main/model-groups/__tests__/sourceRoutes.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  modelGroupAutoSwitchFor,
  modelGroupCandidateKey,
  normalizeModelGroupsConfig,
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

  // 2026-11-26 用户要求补齐：合并整个供应商的路由也能加例外(时段改走、带图只用能看图的来源)，对它展开出的每个模型都生效。
  // 失效后果：例外存了但选路时不看，或目标路由删掉后还指着它。最小输入：一条自己建的、一条自动合成的，各带一条时段例外。
  it('carries the exceptions of a provider route into every model it expands into, and drops them with their target', () => {
    const night = { when: { type: 'hours' as const, from: 22, to: 6 }, use: { type: 'route' as const, routeId: 'cheap' } };
    const cheap = { id: 'cheap', name: 'Cheap', strategy: 'order' as const, candidates: [{ agentKind: 'codex' as const, providerId: 'xd', model: 'openai/gpt-6-luna' }] };
    const stored = normalizeModelGroupsConfig({
      routes: [cheap],
      sourceRoutes: [{ id: 'mine', name: 'Mine', strategy: 'order', sources: [{ providerId: 'openai' }], exceptions: [night] }],
      autoExceptions: { 'auto:openai': [night, { when: { type: 'image' }, use: 'vision' }] },
    });
    const config = effective(stored, [GATEWAY, SUBSCRIPTION, ORGANIZATION]);
    expect(childrenOf(config, 'mine').every((route) => JSON.stringify(route.exceptions) === JSON.stringify([night]))).toBe(true);
    expect(childrenOf(config, 'auto:openai').every((route) => route.exceptions?.length === 2)).toBe(true);
    // 目标路由删掉：两处的时段例外都去掉，图片例外留着。
    const pruned = normalizeModelGroupsConfig({ ...stored, routes: [] });
    expect(pruned.sourceRoutes?.[0].exceptions).toBeUndefined();
    expect(pruned.autoExceptions).toEqual({ 'auto:openai': [{ when: { type: 'image' }, use: 'vision' }] });
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

  // 2026-11-27 用户反馈：本机 OpenAI 有 A、B 两个账号，自己的另两台电脑各登着 A、B，自动路由却列成本机加两台电脑三个成员，
  // 同一份配额被当成两个来源(按额度挑时重复计算，A 满了还会换到另一台电脑上的 A)。只差账号集合是否完全相等的旧规则合不掉它们。
  // 失效后果：另一台电脑上的同一个账号仍是成员。最小输入：本机两个账号，两台电脑各一个其中的账号；另有一台登着别的账号、
  // 一台登着同一个账号但多一个本机没有的模型——这两台都要留下。
  it('leaves out another computer whose accounts are all already in a member on this computer', () => {
    const accounts = (keys: string[], models = ['gpt-6-luna', 'gpt-5.5']) =>
      view('openai', 'OpenAI', 'codex', models, { subscriptionAccountKeys: keys });
    const config = effectiveModelGroupsConfig({ routes: [] }, {
      views: [accounts(['acct-a', 'acct-b']), ORGANIZATION], agents: AGENTS, available: () => true,
      remote: new Map([
        ['laptop', [accounts(['acct-a'])]],
        ['mini', [accounts(['acct-b'])]],
        ['other', [accounts(['acct-c'])]],
        ['newer', [accounts(['acct-a'], ['gpt-6-luna', 'gpt-5.5', 'gpt-6-sol'])]],
      ]),
    });
    expect(config.sourceRoutes?.[0].sources).toEqual([
      { providerId: 'openai' }, { providerId: 'byok-1' },
      { providerId: 'openai', agentDeviceId: 'other' }, { providerId: 'openai', agentDeviceId: 'newer' },
    ]);
    const where = childrenOf(config, 'auto:openai').flatMap((route) => route.candidates.map((item) => item.agentDeviceId ?? 'local'));
    expect(where).not.toContain('laptop');
    expect(where).not.toContain('mini');
    // newer 因多了 gpt-6-sol 保留为成员，但在本机已覆盖的 gpt-6-luna / gpt-5.5 上不再重复展开同一账号。
    const byModel = new Map(childrenOf(config, 'auto:openai').map((route) => [route.name, route.candidates.map((item) => item.agentDeviceId ?? 'local')]));
    expect(byModel.get('GPT-6-SOL')).toEqual(['newer']);
    expect(byModel.get('GPT-6-LUNA')).not.toContain('newer');
    expect(byModel.get('GPT-5.5')).not.toContain('newer');
  });

  // 2026-11-28 用户验收反馈：真实多机下 另一台电脑 关闭了 Fast（allowFast: false / supportsFastMode: false）而本机开启了 Fast，
  // 且远端历史自定义连接带有不同目录元数据（effortsUnknown、imageModels 差异）或多了 1 个旧型号（gpt-5.3-codex-spark）。
  // 失效后果：此前复用浏览列表的 subscriptionModelsCoveredBy 对 allowFast 做严格相等 ===，导致 另一台电脑 无法被去重；
  // 仅靠成员级去重也让多 1 个旧型号的远端在共同模型上重复成为候选。
  // 最小输入：本机池 [A, B]（allowFast: true、含 imageModels）+ laptop [A]（allowFast: false、无 imageModels）+ mini [B]（多 1 个旧模型）。
  it('deduplicates across Fast policy and metadata differences and avoids duplicate candidates on shared models', () => {
    const local = view('openai', 'OpenAI', 'codex', ['gpt-6.2-sol', 'gpt-6.2-astra'], {
      subscriptionAccountKeys: ['acct-a', 'acct-b'],
      subscriptionFastPolicy: { allowFast: true, groupAllowsFast: true },
      imageModels: [{ id: 'openai/gpt-image-2', name: 'GPT Image Gen' }],
    });
    local.models.codex = local.models.codex!.map((model) => ({
      ...model, supportsFastMode: true, supportsUltrafastMode: true, effortsUnknown: false,
    }));
    const laptop = view('openai-remote-a', 'OpenAI · a', 'codex', ['gpt-6.2-sol', 'gpt-6.2-astra'], {
      source: 'user',
      logoKind: 'openai',
      subscriptionAccountKeys: ['acct-a'],
      subscriptionFastPolicy: { allowFast: false, groupAllowsFast: true },
    });
    laptop.models.codex = laptop.models.codex!.map((model) => ({
      ...model, supportsFastMode: false, supportsUltrafastMode: false,
    }));
    const mini = view('openai-remote-b', 'OpenAI · b', 'codex', ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-5.3-codex-spark'], {
      source: 'user',
      logoKind: 'openai',
      subscriptionAccountKeys: ['acct-b'],
      subscriptionFastPolicy: { allowFast: true, groupAllowsFast: true },
    });

    const config = effectiveModelGroupsConfig({ routes: [] }, {
      views: [local, ORGANIZATION], agents: AGENTS, available: () => true,
      remote: new Map([['laptop', [laptop]], ['mini', [mini]]]),
    });
    expect(config.sourceRoutes?.[0].sources).toEqual([
      { providerId: 'openai' },
      { providerId: 'byok-1' },
      { providerId: 'openai-remote-b', agentDeviceId: 'mini' },
    ]);
    const expanded = new Map(childrenOf(config, 'auto:openai').map((route) => [route.name, route.candidates.map((item) => item.agentDeviceId ?? 'local')]));
    expect(expanded.get('GPT-6.2-SOL')).toEqual(['local']);
    expect(expanded.get('GPT-6.2-ASTRA')).toEqual(['local']);
    expect(expanded.get('GPT-5.3-CODEX-SPARK')).toEqual(['mini']);
  });

  // 2026-11-27 review(Greptile P1)：去重不能让已停用(off: true)或本机无法运行对应引擎的成员充当保留方，
  // 否则会把远端唯一可用的来源删掉，导致已选路由无可用候选。
  // 失效后果：远端 laptop 被错误滤除，展开后无可用候选。最小输入：本机 [A, B] + 远端 laptop [A]，分别测试本机被停用、本机缺 codex 引擎、
  // 以及本机 codex 经 available 判定不可用三种情况——laptop 都必须保留并展开为可用候选。
  it('keeps a covered remote computer when the local member is turned off or cannot run the engine', () => {
    const accounts = (keys: string[]) => view('openai', 'OpenAI', 'codex', ['gpt-6-luna'], { subscriptionAccountKeys: keys });
    const local = accounts(['acct-a', 'acct-b']);
    const laptop = accounts(['acct-a']);

    const withLocalOff = effectiveModelGroupsConfig({
      routes: [],
      autoSources: { 'auto:openai': [{ providerId: 'openai', off: true }] },
    }, { views: [local], agents: AGENTS, available: () => true, remote: new Map([['laptop', [laptop]]]) });
    expect(withLocalOff.sourceRoutes?.[0].sources).toEqual([
      { providerId: 'openai', off: true },
      { providerId: 'openai', agentDeviceId: 'laptop' },
    ]);
    expect(childrenOf(withLocalOff, 'auto:openai')[0].candidates).toContainEqual(
      expect.objectContaining({ providerId: 'openai', agentDeviceId: 'laptop' }),
    );

    const withoutLocalCodex = effectiveModelGroupsConfig({ routes: [] }, {
      views: [local], agents: ['claude-code'], available: () => true, remote: new Map([['laptop', [laptop]]]),
    });
    expect(withoutLocalCodex.sourceRoutes?.[0].sources).toEqual([
      { providerId: 'openai' },
      { providerId: 'openai', agentDeviceId: 'laptop' },
    ]);
    expect(childrenOf(withoutLocalCodex, 'auto:openai')[0].candidates.map((item) => item.agentDeviceId)).toEqual(['laptop']);

    const withLocalUnavailable = effectiveModelGroupsConfig({ routes: [] }, {
      views: [local], agents: AGENTS, available: (candidate) => Boolean(candidate.agentDeviceId), remote: new Map([['laptop', [laptop]]]),
    });
    expect(withLocalUnavailable.sourceRoutes?.[0].sources).toEqual([
      { providerId: 'openai' },
      { providerId: 'openai', agentDeviceId: 'laptop' },
    ]);
    expect(childrenOf(withLocalUnavailable, 'auto:openai')[0].candidates.map((item) => item.agentDeviceId)).toEqual(['laptop']);
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

  // 2026-11-26 review(MagicLizi P1)：任务经自动合成的路由落到订阅 A，A 断开后这一家只剩 B，路由不再列出；
  // 已经绑定了这条路由的任务要照样解析到 B、由 B 接替，关掉「出问题时自动换来源」时仍不接替。
  // 失效后果：B 明明能用却接不上(按已存的 id 找不到路由)。最小输入：两个连接，绑定后其中一个断开。
  it('keeps a selected automatic route resolvable to the remaining member after the other connection drops', async () => {
    const both = effective({ routes: [] }, [SUBSCRIPTION, ORGANIZATION]);
    const bound = childrenOf(both, 'auto:openai').find((route) => route.candidates.length === 2)!;
    const first = bound.candidates[0];
    const dropped = [{ ...SUBSCRIPTION, connected: false } as ProviderView, ORGANIZATION];
    const catalog = { views: dropped, agents: AGENTS, available: () => true };
    // 列表与设置页读的那份不再列出这条路由。
    const listed = effectiveModelGroupsConfig({ routes: [] }, catalog);
    expect(listed.sourceRoutes).toBeUndefined();
    expect(listed.routes.some((route) => route.id === bound.id)).toBe(false);
    // 按已选的路由解析的那份：同一个 id 找得到，只剩 B，隐藏、不进 sourceRoutes。
    const forSelected = (stored: ModelGroupsConfig) => effectiveModelGroupsConfig(stored, catalog, { forSelected: true });
    const kept = forSelected({ routes: [] });
    expect(kept.sourceRoutes).toBeUndefined();
    expect(kept.routes.find((route) => route.id === bound.id)).toMatchObject({ hidden: true, parent: { id: 'auto:openai' } });
    const offerFor = (stored: ModelGroupsConfig) => computeModelGroupSwitchOffer({
      readBinding: () => ({ selection: { type: 'route', id: bound.id }, pickedKey: modelGroupCandidateKey(first) }) as never,
      readSession: async () => ({ source: 'desktop', agentKind: first.agentKind, providerId: first.providerId, model: first.model }),
      isShared: () => false,
      hasGoal: async () => false,
      config: () => forSelected(stored),
      candidateFacts: async (route) => route.candidates.map(() => ({ available: true, modelName: 'GPT-6-LUNA', sourceName: 'x', windows: null })),
      now: () => 0,
    }, 'session-1', {
      visited: new Set(), accountUnavailable: true, recordUnavailable: () => undefined,
      current: { agentKind: first.agentKind, providerId: first.providerId, model: first.model },
    });
    await expect(offerFor({ routes: [] })).resolves.toMatchObject({ providerId: 'byok-1', model: 'byok-codex/gpt-6-luna' });
    await expect(offerFor({ routes: [], autoSwitchOff: ['auto:openai'] })).resolves.toBeNull();
  });

  // 2026-11-27 用户反馈(ACP 插件执行引擎如 Antigravity 无法加入智能路由，含本机插件与分享给自己的)：
  // 本机 Antigravity 与分享来的 Antigravity 归同一家自动合成供应商路由，按模型展开出 agentKind='acp' 候选；
  // 停用的本机引擎、未开启远程调用的远端引擎、被关掉的模型均不进入候选。
  it('merges local and shared ACP plugin engines into an automatic route and expands their models', () => {
    const localAgy = {
      key: 'antigravity:agy',
      providerId: 'acp-plugin:antigravity:agy',
      ghostId: 'antigravity',
      harnessId: 'agy',
      name: 'Antigravity',
      availability: { state: 'available' as const },
      models: [
        { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['medium' as const, 'high' as const] },
        { id: 'local-only', displayName: 'Local Only' },
      ],
      permissionModes: [],
      defaultPermissionMode: 'ask' as const,
      remoteUse: { supported: true, enabled: true, shareSupported: true },
    };
    const sharedAgy = {
      ...localAgy,
      key: '_ns__local__antigravity:agy',
      providerId: 'acp-plugin:_ns__local__antigravity:agy',
      ghostId: '_ns__local__antigravity',
      models: [
        { id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['high' as const] },
      ],
    };
    const unsharedAgy = {
      ...sharedAgy,
      remoteUse: { supported: true, enabled: false, shareSupported: true },
    };
    const out = effectiveModelGroupsConfig({ routes: [] }, {
      views: [],
      agents: AGENTS,
      pluginEngines: [localAgy],
      remotePluginEngines: new Map([
        ['share:dash-agy', [sharedAgy]],
        ['dev-other', [unsharedAgy]],
      ]),
      available: () => true,
    });
    expect(out.sourceRoutes).toEqual([expect.objectContaining({
      id: 'auto:antigravity',
      name: 'Antigravity',
      auto: true,
      sources: [
        { providerId: 'acp-plugin:antigravity:agy' },
        { providerId: 'acp-plugin:_ns__local__antigravity:agy', agentDeviceId: 'share:dash-agy' },
      ],
    })]);
    const expanded = childrenOf(out, 'auto:antigravity');
    expect(expanded.map((item) => item.name)).toEqual(['Gemini 4 Neon', 'Local Only']);
    expect(expanded[0]?.candidates).toEqual([
      { agentKind: 'acp', providerId: 'acp-plugin:antigravity:agy', model: 'gemini-4-neon' },
      { agentKind: 'acp', providerId: 'acp-plugin:_ns__local__antigravity:agy', model: 'gemini-4-neon', agentDeviceId: 'share:dash-agy' },
    ]);
    // 手动创建的供应商路由可混放内置供应商与 ACP 插件引擎。
    const manual = effectiveModelGroupsConfig({
      routes: [],
      sourceRoutes: [{
        id: 'sr-mix', name: 'Mix', strategy: 'order',
        sources: [{ providerId: 'openai' }, { providerId: 'acp-plugin:antigravity:agy' }],
      }],
    }, {
      views: [SUBSCRIPTION],
      agents: AGENTS,
      pluginEngines: [{ ...localAgy, disabledModels: [{ id: 'local-only', displayName: 'Local Only' }] }],
      available: () => true,
    });
    const mixChildren = childrenOf(manual, 'sr-mix');
    expect(mixChildren.some((item) => item.candidates.some((c) => c.agentKind === 'acp' && c.model === 'gemini-4-neon'))).toBe(true);
    expect(mixChildren.some((item) => item.candidates.some((c) => c.model === 'local-only'))).toBe(false);
  });

  // 2026-11-28 用户裁决：路由选项里不出现再次合并的嵌套自动来源（无两层自动）。
  // 本机多账号订阅池直接拆平为单账号来源，可逐个开关/排序/权重，并按单账号与本机并集对同账号远端去重。
  // 失效后果：多账号池被包成单个 opaque 成员或无法单独关掉其中一个账号。
  // 最小输入：本机 OpenAI 2 个账号 + OpenAI-Codex + 同账号远端 另一台电脑 + 带旧型号的远端 Mac mini + 分享来源。
  it('flattens local multi-account pools into individual toggleable route sources and deduplicates covered remotes', () => {
    const localOpenAi = view('openai', 'OpenAI', 'codex', ['gpt-6.2-sol', 'gpt-6.2-astra'], {
      subscriptionAccountKeys: ['acct-a', 'acct-b'],
      subscriptionFastPolicy: { allowFast: true },
    });
    const laptop = view('openai-remote-a', 'OpenAI', 'codex', ['gpt-6.2-sol', 'gpt-6.2-astra'], {
      logoKind: 'openai',
      subscriptionAccountKeys: ['acct-a'],
      subscriptionFastPolicy: { allowFast: false },
    });
    const mini = view('openai-remote-b', 'OpenAI', 'codex', ['gpt-6.2-sol', 'gpt-5.3-codex-spark'], {
      logoKind: 'openai',
      subscriptionAccountKeys: ['acct-b'],
    });
    const shareAlex = view('openai', 'OpenAI', 'codex', ['gpt-6.2-sol'], { logoKind: 'openai' });
    const byok = view('byok-1', 'OpenAI-Codex', 'codex', ['byok-codex/gpt-6.2-sol'], {
      source: 'organization',
      logoKind: 'openai-spectrum',
    });
    const localAccounts = new Map([
      ['openai', [
        { id: 'default', label: 'first@example.com', accountKey: 'acct-a', usable: true },
        { id: 'second', label: 'second@example.com', accountKey: 'acct-b', usable: true },
      ]],
    ]);

    const config = effectiveModelGroupsConfig({ routes: [] }, {
      views: [localOpenAi, byok],
      localAccounts,
      agents: AGENTS,
      remote: new Map([
        ['laptop', [laptop]],
        ['mini', [mini]],
        ['share:alex', [shareAlex]],
      ]),
      available: () => true,
    });
    // 本机 2 个账号拆平为 2 个独立来源；另一台电脑 被本机 default 覆盖而剔除；mini 因多了旧型号保留；分享与 BYOK 各自独立。
    expect(config.sourceRoutes?.[0]?.sources).toEqual([
      { providerId: 'openai', accountId: 'default' },
      { providerId: 'openai', accountId: 'second' },
      { providerId: 'byok-1' },
      { providerId: 'openai-remote-b', agentDeviceId: 'mini' },
      { providerId: 'openai', agentDeviceId: 'share:alex' },
    ]);
    // 共同模型 gpt-6.2-sol 上 mini 的重复配额被剔除，只剩 4 个不重不漏的扁平来源。
    const expanded = new Map(childrenOf(config, 'auto:openai').map((route) => [route.name, route.candidates]));
    expect(expanded.get('GPT-6.2-SOL')?.map((c) => [c.providerId, c.accountId ?? null, c.agentDeviceId ?? null])).toEqual([
      ['openai', 'default', null],
      ['openai', 'second', null],
      ['byok-1', null, null],
      ['openai', null, 'share:alex'],
    ]);
    expect(expanded.get('GPT-5.3-CODEX-SPARK')?.map((c) => c.agentDeviceId)).toEqual(['mini']);

    // 单独关掉第 2 个本机账号：只停用该账号，第 1 个账号与其余来源照常启用。
    const withSecondOff = effectiveModelGroupsConfig({
      routes: [],
      autoSources: {
        'auto:openai': [
          { providerId: 'openai', accountId: 'default' },
          { providerId: 'openai', accountId: 'second', off: true },
          { providerId: 'byok-1' },
        ],
      },
    }, {
      views: [localOpenAi, byok],
      localAccounts,
      agents: AGENTS,
      available: () => true,
    });
    expect(withSecondOff.sourceRoutes?.[0]?.sources).toEqual([
      { providerId: 'openai', accountId: 'default' },
      { providerId: 'openai', accountId: 'second', off: true },
      { providerId: 'byok-1' },
    ]);
    const solWithOff = childrenOf(withSecondOff, 'auto:openai').find((r) => r.name === 'GPT-6.2-SOL');
    expect(solWithOff?.candidates.map((c) => [c.providerId, c.accountId ?? null, c.off === true])).toEqual([
      ['openai', 'default', false],
      ['openai', 'second', true],
      ['byok-1', null, false],
    ]);

    // 仅本机一个供应商但有 2 个账号时，也直接拆平合成单层 auto:openai，不再留两层自动。
    const twoAccountsOnly = effectiveModelGroupsConfig({ routes: [] }, {
      views: [localOpenAi],
      localAccounts,
      agents: AGENTS,
      available: () => true,
    });
    expect(twoAccountsOnly.sourceRoutes?.[0]?.sources).toEqual([
      { providerId: 'openai', accountId: 'default' },
      { providerId: 'openai', accountId: 'second' },
    ]);

    // 手动建的供应商路由若仍引用未拆平的本机多账号供应商，读取时同样拆平并继承开关与权重。
    const manualFlattened = effectiveModelGroupsConfig({
      routes: [],
      sourceRoutes: [{
        id: 'custom-gpt', name: 'My GPT', strategy: 'weighted',
        sources: [{ providerId: 'openai', weight: 3 }, { providerId: 'byok-1' }],
      }],
    }, {
      views: [localOpenAi, byok],
      localAccounts,
      agents: AGENTS,
      available: () => true,
    });
    expect(manualFlattened.sourceRoutes?.find((r) => r.id === 'custom-gpt')?.sources).toEqual([
      { providerId: 'openai', accountId: 'default', weight: 3 },
      { providerId: 'openai', accountId: 'second', weight: 3 },
      { providerId: 'byok-1' },
    ]);
  });

  // PR #13634 review, unit: a provider was split into account sources only while two accounts were
  // unpaused. Pausing one in the account pool turned the other back into a whole-provider source, so the
  // off switch, weight and position the user saved on that account no longer matched and it ran again.
  // Minimal input: two accounts, the route turns the first off, then the second is paused in the pool.
  it('keeps an account source and its saved off switch when the other account of the pool is paused', () => {
    const localOpenAi = view('openai', 'OpenAI', 'codex', ['gpt-6.2-sol'], { subscriptionAccountKeys: ['acct-a', 'acct-b'] });
    const byok = view('byok-1', 'OpenAI-Codex', 'codex', ['byok-codex/gpt-6.2-sol'], { source: 'organization', logoKind: 'openai-spectrum' });
    const config = effectiveModelGroupsConfig({
      routes: [],
      autoSources: {
        'auto:openai': [
          { providerId: 'byok-1', weight: 2 },
          { providerId: 'openai', accountId: 'default', off: true },
          { providerId: 'openai', accountId: 'second' },
        ],
      },
    }, {
      views: [localOpenAi, byok],
      localAccounts: new Map([['openai', [
        { id: 'default', label: 'first@example.com', accountKey: 'acct-a', usable: true },
        { id: 'second', label: 'second@example.com', accountKey: 'acct-b', usable: false, paused: true },
      ]]]),
      agents: AGENTS,
      available: () => true,
    });
    expect(config.sourceRoutes?.[0]?.sources).toEqual([
      { providerId: 'byok-1', weight: 2 },
      { providerId: 'openai', accountId: 'default', off: true },
    ]);
    const sol = childrenOf(config, 'auto:openai').find((route) => route.name === 'GPT-6.2-SOL');
    expect(sol?.candidates.map((c) => [c.providerId, c.accountId ?? null, c.off === true])).toEqual([
      ['byok-1', null, false],
      ['openai', 'default', true],
    ]);
  });
});

// Unit: current placement must not add old connection names alongside the
// real slots. Preserve the per-account controls introduced by #13658.
it.each(['subscription', 'mixed'] as const)('lists each real %s account once and restores a detached connection', kind => {
  const aliases = [view('old-openai', 'Old subscription', 'codex', ['gpt-6-luna'], { logoKind: 'openai', subscriptionPoolAlias: true, subscriptionPoolTarget: 'openai' }),
    ...(kind === 'mixed' ? [view('old-key', 'Old Key', 'codex', ['gpt-6-luna'], { logoKind: 'openai', subscriptionPoolAlias: true, subscriptionPoolTarget: 'openai' })] : [])];
  const accounts = [{ id: 'default', label: 'Native A', usable: true }, { id: 'second', label: 'Native B', usable: true },
    ...(kind === 'mixed' ? [{ id: 'key-member', label: 'Key', usable: true }] : [])];
  const selected = accounts.map((account, index) => ({ providerId: 'openai', accountId: account.id, ...(index ? { weight: 7 } : { off: true as const }) }));
  const stored: ModelGroupsConfig = { routes: [], autoSources: { 'auto:openai': [...selected, ...aliases.map(alias => ({ providerId: alias.id }))] } };
  const read = (old: ProviderView[], local = accounts) => effectiveModelGroupsConfig(stored, {
    views: [SUBSCRIPTION, ...old], agents: AGENTS, available: () => true, localAccounts: new Map([['openai', local]]),
  });
  const merged = read(aliases);
  expect(merged.sourceRoutes?.find(route => route.auto)?.sources).toEqual(selected);
  const shared = childrenOf(merged, 'auto:openai').find(route => route.name === 'GPT-6-LUNA')!;
  expect(shared.candidates.map(({ providerId, accountId, off, weight }) => ({ providerId, accountId, ...(off ? { off } : {}), ...(weight ? { weight } : {}) }))).toEqual(selected);
  const split = read(aliases.map(alias => ({ ...alias, subscriptionPoolAlias: undefined, subscriptionPoolTarget: undefined })), accounts.slice(0, 1));
  expect(split.sourceRoutes?.find(route => route.auto)?.sources.some(source => source.providerId === aliases[0].id)).toBe(true);
});
