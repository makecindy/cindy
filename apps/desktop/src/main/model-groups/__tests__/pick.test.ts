/**
 * 测试价值
 * - 生产入口与可观察结果：pickModelGroupCandidate / createModelGroupResolver.resolve——新任务最终用哪个来源、
 *   以及任务里写给用户的原因。
 * - 规则依据：docs/product-rules/model-groups.md §3 选法、§4 用不了时。
 * - 现有覆盖缺口：供应商组的排序只覆盖「同一供应商的多台电脑」，不覆盖跨来源候选、停用、未连接与全部撞限。
 * - 最小失败输入：两个订阅一个周额度明天重置、一个周日重置；选错即把快作废的额度留到作废。
 * - 最省钱：还有配额的订阅不另外花钱，排在任何标价之前；没有标价的排在有标价的后面；一样便宜按列表顺序。
 * - 例外(§3)：有图片时只在能看图的来源里选，一个都没有就照常选；时段例外改走另一条路线，跨午夜也算，
 *   指向已删除或绕回来的路线时整条改道作废、按原路线选。
 * - 推理强度(§4)：用最后实际走的那条路线的；选中的模型不支持这一档时不带。旧版存下的模式与选中的模式读取时
 *   忽略，不报错。
 * - 远程与分享来的来源(§3.1)：选中时结果带运行位置；位置不在名单里或读目录超时按不可用、换下一个；同一个连接 ID
 *   在本机与另一台电脑上是两个来源，本机的额度不给另一台用；旧数据(没有位置)照常按本机，也不去读别处。
 * - tier：unit，纯函数与注入依赖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import {
  modelGroupCandidateKey,
  normalizeModelGroupsConfig,
  sanitizeModelGroupSelection,
  type ModelGroupRoute,
  type ModelGroupResolveResult,
  type ModelGroupSelection,
  type ModelGroupsConfig,
  type ModelGroupTraceQuota,
} from '../../../shared/modelGroups.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from '../pick.js';
import { createModelGroupResolver, MODEL_GROUP_REMOTE_WAIT_MS, modelGroupQuotaKey } from '../resolver.js';

const NOW = Date.UTC(2026, 10, 11, 4);
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const week = (usedPercent: number, resetInHours: number): ModelGroupTraceQuota =>
  ({ usedPercent, resetAtMs: NOW + resetInHours * HOUR, windowMs: WEEK });
const fiveHour = (usedPercent: number, resetInHours: number): ModelGroupTraceQuota =>
  ({ usedPercent, resetAtMs: NOW + resetInHours * HOUR, windowMs: 5 * HOUR });

const route = (strategy: ModelGroupRoute['strategy'], off: number[] = []): ModelGroupRoute => ({
  id: 'r1', name: '主力编程', strategy,
  candidates: ['a', 'b', 'api'].map((providerId, index) => ({
    agentKind: 'codex', providerId, model: 'gpt', ...(off.includes(index) ? { off: true } : {}),
  })),
});
const fact = (windows: ModelGroupTraceQuota[] | null, available = true): ModelGroupCandidateFacts =>
  ({ available, modelName: 'GPT', sourceName: 'S', windows });

/** a：周额度周日才重置；b：明天重置还剩 61%；api：读不到额度。 */
const FACTS = [fact([week(26, 100)]), fact([week(39, 20)]), fact(null)];

describe('pickModelGroupCandidate', () => {
  it.each([
    ['expiring', undefined, 1, 'expiring'],
    ['order', undefined, 0, 'order'],
    ['rotate', 'codex\u0000a\u0000gpt', 1, 'rotate'],
    ['rotate', 'codex\u0000api\u0000gpt', 0, 'rotate'],
  ] as const)('%s picks by its own rule', (strategy, lastPickedKey, index, why) => {
    const picked = pickModelGroupCandidate(route(strategy), FACTS, { now: NOW, lastPickedKey });
    expect(picked.index).toBe(index);
    expect(picked.trace[index]).toMatchObject({ state: 'picked', why });
  });

  it('explains every candidate it did not pick', () => {
    const facts = [
      fact([week(100, 30)]),
      fact([week(10, 20), fiveHour(95, 4)]),
      fact([week(50, 20)]),
      fact(null, false),
    ];
    const four: ModelGroupRoute = {
      ...route('expiring'),
      candidates: [...route('expiring').candidates, { agentKind: 'codex', providerId: 'gone', model: 'gpt' }],
    };
    const picked = pickModelGroupCandidate(four, facts, { now: NOW });
    expect(picked.index).toBe(2);
    expect(picked.trace.map((entry) => entry.why)).toEqual(['limited', 'tight', 'expiring', 'unavailable']);
    expect(picked.trace[0].limitedUntilMs).toBe(NOW + 30 * HOUR);
  });

  it('skips a source the user turned off even when it is the most urgent', () => {
    const picked = pickModelGroupCandidate(route('expiring', [1]), FACTS, { now: NOW });
    expect(picked.index).toBe(0);
    expect(picked.trace[1]).toMatchObject({ state: 'skipped', why: 'off' });
  });

  it('falls back to the source that recovers first when every one is exhausted', () => {
    const facts = [fact([week(100, 50)]), fact([week(100, 3)]), fact(null, false)];
    const picked = pickModelGroupCandidate(route('order'), facts, { now: NOW });
    expect(picked.index).toBe(1);
    expect(picked.trace[1]).toMatchObject({ state: 'picked', why: 'soonest', limitedUntilMs: NOW + 3 * HOUR });
  });

  const priced = (price: number | null, extra: Partial<ModelGroupCandidateFacts> = {}): ModelGroupCandidateFacts =>
    ({ ...fact(null), price, ...extra });
  it.each([
    ['a subscription with quota left costs nothing extra', [fact([week(26, 100)]), priced(15), priced(3)], 0, 'cheapestFree'],
    ['an exhausted subscription falls to the lowest listed price', [fact([week(100, 10)]), priced(15), priced(3)], 2, 'cheapest'],
    ['an unknown price ranks after known ones; ties keep list order', [priced(null), priced(15), priced(15)], 1, 'cheapest'],
    ['with no price known it only takes the first, not "cheapest"', [priced(null), priced(null), priced(null)], 0, 'order'],
  ] as const)('cheapest: %s', (_name, facts, index, why) => {
    const picked = pickModelGroupCandidate(route('cheapest'), facts, { now: NOW });
    expect(picked.index).toBe(index);
    expect(picked.trace[index]).toMatchObject({ state: 'picked', why });
  });

  it('keeps only sources that can see images when the message has one, and says when none can', () => {
    const vision = [fact(null), { ...fact(null), acceptsImage: true }, fact(null)];
    const applied = pickModelGroupCandidate(route('order'), vision, { now: NOW, needsImage: true });
    expect(applied).toMatchObject({ index: 1, image: 'applied' });
    expect(applied.trace[0]).toMatchObject({ state: 'skipped', why: 'noVision' });
    const fallback = pickModelGroupCandidate(route('order'), FACTS, { now: NOW, needsImage: true });
    expect(fallback).toMatchObject({ index: 0, image: 'fallback' });
  });

  it('picks nothing when no source is connected', () => {
    const picked = pickModelGroupCandidate(route('expiring'), [fact(null, false), fact(null, false), fact(null, false)], { now: NOW });
    expect(picked.index).toBeNull();
  });
});

describe('createModelGroupResolver', () => {
  const view = (id: string, name: string, supportsImageInput = false) => ({
    id, name, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: [{ id: 'gpt', name: 'GPT-5.6', mode: 'chat', efforts: ['low', 'high'], supportsImageInput }] },
  }) as unknown as ProviderView;
  const config: ModelGroupsConfig = { routes: [route('rotate')] };
  const make = (groups: ModelGroupsConfig = config, now = NOW) => createModelGroupResolver({
    config: () => groups,
    views: async () => [view('a', 'ChatGPT Pro'), view('b', 'ChatGPT Plus', true)],
    agents: () => ['codex'],
    harnessInstalled: async () => true,
    quotaWindows: async () => new Map([['a', [week(26, 100)]], ['b', [week(39, 20)]]]),
    scope: () => 'owner',
    now: () => now,
  });

  it('advances rotation only after adoption, not on cancelled picks or previews (#10240)', async () => {
    const resolver = make();
    const selection = { type: 'route', id: 'r1' } as const;
    const first = await resolver.resolve({ selection });
    const cancelled = await resolver.resolve({ selection });
    expect(cancelled).toMatchObject({ outcome: 'routed', route: { providerId: 'a' } });
    expect(resolver.commit(first.decisionId!)).toBe(true);
    expect(resolver.commit(first.decisionId!)).toBe(false);
    const preview = await resolver.resolve({ selection, dryRun: true });
    expect(preview.decisionId).toBeUndefined();
    const second = await resolver.resolve({ selection });
    expect([first, preview, second].map((r) => r.outcome === 'routed' && r.route.providerId)).toEqual(['a', 'b', 'b']);
    // 第三个候选没有连接：轮到它时跳回第一个，并写明它为什么没被选。
    resolver.commit(second.decisionId!);
    const third = await resolver.resolve({ selection });
    expect(third).toMatchObject({ outcome: 'routed', route: { providerId: 'a' }, sourceName: 'ChatGPT Pro', modelName: 'GPT-5.6' });
    expect(third.trace[2]).toMatchObject({ why: 'unavailable' });
  });

  // #10240: resolve used to record before confirmation. Unit: two resolves without
  // adoption must leave history empty; only one same-account commit may record.
  it('records only committed results and rejects expired or other-account receipts', async () => {
    let scope = 'one';
    let now = NOW;
    const history: ModelGroupResolveResult[] = [];
    const resolver = createModelGroupResolver({
      config: () => config, views: async () => [view('a', 'A'), view('b', 'B')],
      agents: () => ['codex'], harnessInstalled: async () => true,
      quotaWindows: async () => new Map(), scope: () => scope, now: () => now,
      recordDecision: (_selection, result) => { history.push(result); },
    });
    const request = { selection: { type: 'route', id: 'r1' } } as const;
    const cancelled = await resolver.resolve(request);
    const adopted = await resolver.resolve(request);
    expect(history).toEqual([]);
    expect(resolver.commit(adopted.decisionId!)).toBe(true);
    expect(resolver.commit(adopted.decisionId!)).toBe(false);
    expect(history).toHaveLength(1);
    scope = 'two';
    expect(resolver.commit(cancelled.decisionId!)).toBe(false);
    const expired = await resolver.resolve(request);
    now += 60 * 60_000 + 1;
    expect(resolver.commit(expired.decisionId!)).toBe(false);
    expect(history).toHaveLength(1);
    const fallback = await resolver.resolve({ selection: { type: 'route', id: 'missing' } });
    expect(resolver.commit(fallback.decisionId!)).toBe(true);
    expect(history[1].outcome).toBe('missing');
  });

  // PR #9974 review：分模型周配额的窗口按模型家族归属，不看用户改过的显示名，也不要求显示名包含整个窗口标签。
  it.each([
    ['Claude Fable', 'claude-fable-5', '我的主力', 'b'],
    ['Fable 5', 'claude-fable-5', 'Fable', 'b'],
    ['Opus', 'claude-fable-5', 'Fable 5', 'a'],
  ] as const)('applies a model-scoped window %s to model %s named %s', async (label, modelId, modelName, picked) => {
    const claude = (id: string) => ({
      id, name: id, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
      models: { codex: [{ id: modelId, name: modelName, mode: 'chat', efforts: [] }] },
    }) as unknown as ProviderView;
    const groups: ModelGroupsConfig = {
      routes: [{ id: 'r1', name: 'R', strategy: 'order', candidates: [
        { agentKind: 'codex', providerId: 'a', model: modelId }, { agentKind: 'codex', providerId: 'b', model: modelId },
      ] }],
    };
    const resolver = createModelGroupResolver({
      config: () => groups,
      views: async () => [claude('a'), claude('b')],
      agents: () => ['codex'],
      harnessInstalled: async () => true,
      // a 的总周配额还有余量，但这个标签的分模型周配额已满。
      quotaWindows: async () => new Map([['a', [week(10, 100), { ...week(100, 100), scopedTo: label }]], ['b', [week(10, 100)]]]),
      scope: () => 'owner',
      now: () => NOW,
    });
    expect(await resolver.resolve({ selection: { type: 'route', id: 'r1' } })).toMatchObject({ outcome: 'routed', route: { providerId: picked } });
  });

  it('reports a deleted selection as missing so the task keeps the user\'s own model', async () => {
    expect((await make().resolve({ selection: { type: 'route', id: 'gone' } })).outcome).toBe('missing');
  });

  /** r1 按顺序先用 a；r2「省着用」只有 b。时间按本机时区取。 */
  const at = (hour: number) => new Date(2026, 10, 11, hour, 30).getTime();
  const hoursConfig = (exceptions: ModelGroupRoute['exceptions'], back?: ModelGroupRoute['exceptions']): ModelGroupsConfig => ({
    routes: [
      { ...route('order'), exceptions },
      { id: 'r2', name: '省着用', strategy: 'order', candidates: [{ agentKind: 'codex', providerId: 'b', model: 'gpt' }], ...(back ? { exceptions: back } : {}) },
    ],
  });
  const toR2 = (from: number, to: number) => [{ when: { type: 'hours', from, to }, use: { type: 'route', routeId: 'r2' } }] as ModelGroupRoute['exceptions'];

  it.each([
    ['inside a daytime window', 14, toR2(9, 18), 'b'],
    ['outside it', 20, toR2(9, 18), 'a'],
    ['late evening in a window that wraps past midnight', 23, toR2(22, 6), 'b'],
    ['early morning in the same window', 2, toR2(22, 6), 'b'],
    ['when the window points at a deleted route', 23, [{ when: { type: 'hours', from: 22, to: 6 }, use: { type: 'route', routeId: 'gone' } }], 'a'],
  ] as const)('hours exception %s', async (_name, hour, exceptions, providerId) => {
    const result = await make(hoursConfig([...exceptions!]), at(hour)).resolve({ selection: { type: 'route', id: 'r1' } });
    expect(result).toMatchObject({ outcome: 'routed', groupName: '主力编程', route: { providerId } });
    expect(result.outcome === 'routed' ? result.exceptions : null).toEqual(providerId === 'b' ? [{ type: 'hours', viaRouteName: '省着用' }] : undefined);
  });

  /** 模型只支持 low / high。 */
  it.each([
    ['the route\'s own effort', 20, 'high', undefined, 'high'],
    ['nothing when the picked model does not support it', 20, 'xhigh', undefined, undefined],
    ['the effort of the route an hours exception switched to', 14, 'high', 'low', 'low'],
    ['no effort when the switched-to route has none', 14, 'high', undefined, undefined],
  ] as const)('applies %s', async (_name, hour, ownEffort, otherEffort, expected) => {
    const groups = hoursConfig(toR2(9, 18));
    groups.routes[0] = { ...groups.routes[0], effort: ownEffort };
    if (otherEffort) groups.routes[1] = { ...groups.routes[1], effort: otherEffort };
    const result = await make(groups, at(hour)).resolve({ selection: { type: 'route', id: 'r1' } });
    expect(result.outcome).toBe('routed');
    expect(result.outcome === 'routed' ? result.route.effort : 'unrouted').toBe(expected);
  });

  it('reads a config and a selection saved before modes were merged into routes', async () => {
    const saved = normalizeModelGroupsConfig({
      routes: [{ ...route('order'), effort: 'high' }],
      modes: [{ id: 'm1', name: '深入', target: { type: 'route', routeId: 'r1' }, effort: 'high' }],
    });
    expect(saved).toEqual({ routes: [{ ...route('order'), effort: 'high' }] });
    expect(sanitizeModelGroupSelection({ type: 'mode', id: 'm1' })).toBeNull();
    // 草稿里还留着旧模式的 id 时也只按没有选处理。
    const old = { type: 'mode', id: 'r1' } as unknown as ModelGroupSelection;
    expect((await make(saved).resolve({ selection: old })).outcome).toBe('missing');
  });

  it('drops a reroute that loops back and picks from the original route', async () => {
    const back = [{ when: { type: 'hours', from: 0, to: 23 }, use: { type: 'route', routeId: 'r1' } }] as ModelGroupRoute['exceptions'];
    const result = await make(hoursConfig(toR2(0, 23), back), at(10)).resolve({ selection: { type: 'route', id: 'r1' } });
    expect(result).toMatchObject({ outcome: 'routed', route: { providerId: 'a' } });
    expect(result.outcome === 'routed' && 'exceptions' in result).toBe(false);
  });

  it('uses the image exception only when the first message has images', async () => {
    const groups = hoursConfig([{ when: { type: 'image' }, use: 'vision' }]);
    const selection = { type: 'route', id: 'r1' } as const;
    expect(await make(groups).resolve({ selection })).toMatchObject({ route: { providerId: 'a' } });
    const withImage = await make(groups).resolve({ selection, context: { hasImages: true } });
    expect(withImage).toMatchObject({ route: { providerId: 'b' }, exceptions: [{ type: 'image' }] });
    expect(withImage.trace[0]).toMatchObject({ state: 'skipped', why: 'noVision' });
  });

  it('saves only well-formed exceptions that point at another existing route', () => {
    const saved = normalizeModelGroupsConfig({
      routes: [{
        ...route('order'),
        exceptions: [
          { when: { type: 'image' }, use: 'vision' },
          { when: { type: 'image' }, use: 'vision' },
          { when: { type: 'hours', from: 22, to: 6 }, use: { type: 'route', routeId: 'r2' } },
          { when: { type: 'hours', from: 8, to: 8 }, use: { type: 'route', routeId: 'r2' } },
          { when: { type: 'hours', from: 22, to: 24 }, use: { type: 'route', routeId: 'r2' } },
          { when: { type: 'hours', from: 1, to: 2 }, use: { type: 'route', routeId: 'r1' } },
          { when: { type: 'hours', from: 1, to: 2 }, use: { type: 'route', routeId: 'gone' } },
          { when: { type: 'speed' } },
        ],
      }, { id: 'r2', name: '省着用', strategy: 'cheapest', candidates: [] }],
    });
    expect(saved.routes[0].exceptions).toEqual([
      { when: { type: 'image' }, use: 'vision' },
      { when: { type: 'hours', from: 22, to: 6 }, use: { type: 'route', routeId: 'r2' } },
    ]);
    expect(saved.routes[1]).toEqual({ id: 'r2', name: '省着用', strategy: 'cheapest', candidates: [] });
  });
});

describe('createModelGroupResolver with sources on other computers', () => {
  afterEach(() => { vi.useRealTimers(); });

  const view = (id: string, name: string) => ({
    id, name, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: [{ id: 'gpt', name: 'GPT-5.6', mode: 'chat', efforts: ['low', 'high'] }] },
  }) as unknown as ProviderView;
  /** 本机的 a 与 dev-2 上同 ID 的 a，外加本机的 b。 */
  const REMOTE = { agentKind: 'codex', providerId: 'a', model: 'gpt', agentDeviceId: 'dev-2' } as const;
  const groups = (strategy: ModelGroupRoute['strategy'], candidates: ModelGroupRoute['candidates'], effort?: string): ModelGroupsConfig =>
    ({ routes: [{ id: 'r1', name: '两台电脑', strategy, candidates, ...(effort ? { effort } : {}) }] });
  const make = (config: ModelGroupsConfig, overrides: Partial<Parameters<typeof createModelGroupResolver>[0]> = {}) => {
    const deps = {
      config: () => config,
      views: async () => [view('a', 'ChatGPT Pro'), view('b', 'API')],
      agents: () => ['codex'],
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map<string, ModelGroupTraceQuota[]>(),
      scope: () => 'owner',
      now: () => NOW,
      locations: vi.fn(async () => ({ locations: [{ agentDeviceId: 'dev-2' }] })),
      remoteViews: vi.fn(async () => ({ views: [view('a', 'Studio 上的 ChatGPT')], stale: false })),
      ...overrides,
    };
    return { deps, resolver: createModelGroupResolver(deps) };
  };
  const selection = { type: 'route', id: 'r1' } as const;

  it('runs the task where the picked source is, judged by that computer\'s catalog rather than local installs', async () => {
    // 本机没装 Codex 也不影响另一台电脑上的来源；推理强度按那台的目录看支不支持。
    const { resolver } = make(groups('order', [REMOTE, { agentKind: 'codex', providerId: 'b', model: 'gpt' }], 'high'),
      { harnessInstalled: async (_agent, agentDeviceId) => agentDeviceId === 'dev-2' });
    const result = await resolver.resolve({ selection });
    expect(result).toMatchObject({
      outcome: 'routed',
      route: { agentKind: 'codex', providerId: 'a', model: 'gpt', agentDeviceId: 'dev-2', effort: 'high' },
      sourceName: 'Studio 上的 ChatGPT',
    });
    expect(result.trace[0]).toMatchObject({ state: 'picked', agentDeviceId: 'dev-2' });
    expect(result.trace[1]).toMatchObject({ why: 'unavailable' });
    expect(result.trace[1]).not.toHaveProperty('agentDeviceId');
  });

  it.each([
    ['the computer is not selectable now (offline or share revoked)', { locations: async () => ({ locations: [] }) }],
    ['reading its catalog fails', { remoteViews: async () => { throw new Error('NOT_CONNECTED'); } }],
    // 读失败时底层可能给回上次的目录(stale)；那份目录不说明那台现在能用。
    ['only a stale copy of its catalog comes back', { remoteViews: async () => ({ views: [view('a', 'Studio 上的 ChatGPT')], stale: true }) }],
    // 目录里列着模型，但那台没装对应引擎(与插件选路同一判断)；本机装没装不影响这一条。
    ['its catalog lists the model but that computer has no engine installed', { harnessInstalled: async (_agent: string, agentDeviceId?: string) => !agentDeviceId }],
  ] as const)('moves on when %s', async (_name, overrides) => {
    const { resolver } = make(groups('order', [REMOTE, { agentKind: 'codex', providerId: 'b', model: 'gpt' }]), overrides);
    const result = await resolver.resolve({ selection });
    expect(result).toMatchObject({ outcome: 'routed', route: { providerId: 'b' } });
    expect(result.outcome === 'routed' && 'agentDeviceId' in result.route).toBe(false);
    expect(result.trace[0]).toMatchObject({ state: 'skipped', why: 'unavailable', agentDeviceId: 'dev-2' });
  });

  it('does not wait past the time limit for a computer that never answers, and keeps the user\'s model when nothing else is left', async () => {
    vi.useFakeTimers();
    const { resolver } = make(groups('order', [REMOTE]), { remoteViews: () => new Promise<{ views: ProviderView[]; stale: boolean }>(() => undefined) });
    const pending = resolver.resolve({ selection });
    await vi.advanceTimersByTimeAsync(MODEL_GROUP_REMOTE_WAIT_MS);
    expect(await pending).toMatchObject({ outcome: 'unavailable', trace: [{ why: 'unavailable', agentDeviceId: 'dev-2' }] });
  });

  it('treats the same connection ID on two computers as two sources and never lends local quota to the remote one', async () => {
    const local = { agentKind: 'codex', providerId: 'a', model: 'gpt' } as const;
    const saved = normalizeModelGroupsConfig(groups('expiring', [local, REMOTE]));
    expect(saved.routes[0].candidates).toEqual([local, REMOTE]);
    // 本机的键与旧版一致，旧的轮流位置与任务记录照常对得上。
    expect(modelGroupCandidateKey(local)).toBe('codex\u0000a\u0000gpt');
    expect(modelGroupCandidateKey(REMOTE)).not.toBe(modelGroupCandidateKey(local));
    // 本机 a 的周额度已用完；dev-2 上的 a 没有读数，不能因此也算用完。
    const { resolver } = make(saved, { quotaWindows: async () => new Map([['a', [week(100, 30)]]]) });
    const result = await resolver.resolve({ selection });
    expect(result).toMatchObject({ outcome: 'routed', route: { agentDeviceId: 'dev-2' } });
    expect(result.trace[0]).toMatchObject({ why: 'limited' });
    expect(result.trace[1]).toMatchObject({ state: 'picked', quota: null });
    // 那台电脑自己的读数按位置给它。
    const own = make(saved, { quotaWindows: async () => new Map([['a', [week(100, 30)]], [modelGroupQuotaKey('dev-2', 'a'), [week(100, 10)]]]) });
    expect((await own.resolver.resolve({ selection })).trace[1]).toMatchObject({ state: 'picked', why: 'soonest', limitedUntilMs: NOW + 10 * HOUR });
  });

  // 2026-11-13：进行中的任务里选模式，任务换不了电脑，只在任务所在的位置里挑；别处的来源不选、也不去读那边的目录。
  it('picks only at the running task\'s location when one is given', async () => {
    const local = { agentKind: 'codex', providerId: 'b', model: 'gpt' } as const;
    const { deps, resolver } = make(groups('order', [REMOTE, local]));
    const here = await resolver.resolve({ selection, location: { agentDeviceId: null } });
    expect(here).toMatchObject({ outcome: 'routed', route: { providerId: 'b' } });
    expect(here.outcome === 'routed' && 'agentDeviceId' in here.route).toBe(false);
    expect(deps.remoteViews).not.toHaveBeenCalled();
    const there = await resolver.resolve({ selection, location: { agentDeviceId: 'dev-2' } });
    expect(there).toMatchObject({ outcome: 'routed', route: { providerId: 'a', agentDeviceId: 'dev-2' } });
  });

  it('keeps a candidate saved without a location on this computer and reads nothing elsewhere', async () => {
    const saved = normalizeModelGroupsConfig({ routes: [{ id: 'r1', name: '旧路线', strategy: 'order', candidates: [{ agentKind: 'codex', providerId: 'a', model: 'gpt' }] }] });
    const { deps, resolver } = make(saved);
    const result = await resolver.resolve({ selection });
    expect(result).toMatchObject({ outcome: 'routed', route: { providerId: 'a' }, sourceName: 'ChatGPT Pro' });
    expect(result.outcome === 'routed' && 'agentDeviceId' in result.route).toBe(false);
    expect(deps.locations).not.toHaveBeenCalled();
    expect(deps.remoteViews).not.toHaveBeenCalled();
  });
});
