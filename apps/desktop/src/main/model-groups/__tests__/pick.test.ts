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
 * - 2026-11-21 新增：用完再换、余量最多的先用、按权重三种选法，时段例外可只在某几天；发给别的设备时带旧版认识的选法。
 * - 远程与分享来的来源(§3.1)：选中时结果带运行位置；位置不在名单里或读目录超时按不可用、换下一个；同一个连接 ID
 *   在本机与另一台电脑上是两个来源，本机的额度不给另一台用；旧数据(没有位置)照常按本机，也不去读别处。
 * - tier：unit，纯函数与注入依赖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import {
  modelGroupAutoSwitchFor,
  modelGroupAutoSwitchOn,
  modelGroupCandidateKey,
  modelGroupResolveResultForRemote,
  modelGroupResolveResultFromRemote,
  modelGroupsConfigForRemote,
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
import { createSshModelGroupSupport } from '../sshFilter.js';

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
  const make = (groups: ModelGroupsConfig = config, now = NOW, billingUnavailable?: (id: string) => boolean) => createModelGroupResolver({
    billingUnavailable,
    config: () => groups,
    views: async () => [view('a', 'ChatGPT Pro'), view('b', 'ChatGPT Plus', true)],
    agents: () => ['codex'],
    harnessInstalled: async () => true,
    quotaWindows: async () => new Map([['a', [week(26, 100)]], ['b', [week(39, 20)]]]),
    scope: () => 'owner',
    now: () => now,
  });

  // #12353 / unit: resolve a configured group when a billing hold outlives the failing task.
  it('routes around a held connection only to selectable members of the configured group', async () => {
    const group = route('order');
    const resolver = make({ routes: [group] }, NOW, id => id === 'a');
    const selection = { type: 'route', id: group.id } as const;
    const request = { selection, context: { scheduled: true } };
    expect(await resolver.resolve({ selection })).toMatchObject({ outcome: 'routed', route: { providerId: 'a' } });
    expect(await resolver.resolve(request)).toMatchObject({ outcome: 'routed', route: { providerId: 'b' } });
    group.candidates[1].off = true;
    expect(await resolver.resolve(request)).toMatchObject({ outcome: 'unavailable' });
  });

  // 生产入口与可观察结果：createModelGroupResolver.resolve 对本地与远程 acp 插件引擎候选的可用性、努力档、看图与远程调用判定。
  // 规则依据：2026-11-27 模型组支持 acp 插件引擎，按实时插件目录校验 availability/suspended/disabledModels/defaultModelAllowed/efforts。
  // 覆盖缺口：此前 ModelGroupCandidate 拒绝 'acp'，解析器没有任何插件引擎候选覆盖。
  // 最小失败输入与 tier：unit，构造停用与可用本地/远程插件引擎的候选列表并调用 resolver.resolve。
  it('evaluates local and remote plugin engine (acp) candidates with availability, effort, and disabled-model rules', async () => {
    const DSH = 'acp-plugin:dsh-acp:dsh';
    const AGY = 'acp-plugin:agy-acp:agy';
    const acpGroup: ModelGroupsConfig = {
      routes: [
        {
          id: 'r-acp',
          name: '插件路线',
          strategy: 'order',
          effort: 'high',
          candidates: [
            { agentKind: 'acp', providerId: DSH, model: 'deepseek-v4' },
            { agentKind: 'acp', providerId: AGY, model: 'gemini-3-pro', agentDeviceId: 'studio' },
          ],
        },
      ],
    };
    const resolver = createModelGroupResolver({
      config: () => acpGroup,
      views: async () => [],
      agents: () => ['codex'],
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map(),
      pluginEngines: () => [
        {
          key: 'dsh-acp:dsh',
          providerId: DSH,
          ghostId: 'dsh-acp',
          harnessId: 'dsh',
          name: 'DeepSeek Harness',
          availability: { state: 'available' },
          suspended: true,
          models: [{ id: 'deepseek-v4', displayName: 'DeepSeek V4', efforts: ['high'] }],
          permissionModes: [{ id: 'ask' }],
          defaultPermissionMode: 'ask',
        } as never,
      ],
      remotePluginEngines: async (deviceId) =>
        deviceId === 'studio'
          ? [
              {
                key: 'agy-acp:agy',
                providerId: AGY,
                ghostId: 'agy-acp',
                harnessId: 'agy',
                name: 'Antigravity',
                availability: { state: 'available' },
                remoteUse: { supported: true, enabled: true },
                models: [{ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', efforts: ['low', 'high'] }],
                reportedModelDetails: [{ modelId: 'gemini-3-pro', imageInput: true }],
                permissionModes: [{ id: 'ask' }],
                defaultPermissionMode: 'ask',
              } as never,
            ]
          : [],
      locations: async () => ({ locations: [{ agentDeviceId: 'studio' }] }),
      scope: () => 'owner',
      now: () => NOW,
    });

    const resolved = await resolver.resolve({ selection: { type: 'route', id: 'r-acp' }, context: { hasImages: true } });
    expect(resolved).toMatchObject({
      outcome: 'routed',
      route: {
        agentKind: 'acp',
        providerId: AGY,
        model: 'gemini-3-pro',
        agentDeviceId: 'studio',
        effort: 'high',
      },
      modelName: 'Gemini 3 Pro',
      sourceName: 'Antigravity',
    });
    expect(resolved.trace[0]).toMatchObject({ state: 'skipped', why: 'unavailable' });
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

  // model-groups.md §3(2026-11-26，dash 建议)：来源背后是电脑组或几个账号时，外层按内层下一个会接任务的那一个判断。
  // 此前只看额度总览里本机那一份快照，b 读着最急就选 b，即使组里下一台已经用完或 5 小时快满。
  it('judges a source by the next member its own computer group or account pool would use', async () => {
    const selection = { type: 'route', id: 'r1' } as const;
    const base = {
      config: () => ({ routes: [route('expiring')] }),
      views: async () => [view('a', 'ChatGPT Pro'), view('b', 'ChatGPT Plus', true)],
      agents: () => ['codex'] as const,
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map([['a', [week(26, 100)]], ['b', [week(39, 20)]]]),
      scope: () => 'owner',
      now: () => NOW,
    };
    expect(await createModelGroupResolver(base).resolve({ selection })).toMatchObject({ route: { providerId: 'b' } });
    const asked: string[] = [];
    const inner = (b: { limited: boolean; fiveHourTight: boolean }) => createModelGroupResolver({ ...base,
      innerQuota: async ({ providerId }) => {
        asked.push(providerId);
        return providerId === 'b' ? { ...b, urgency: 5, headroom: 10 } : null;
      } });
    expect(await inner({ limited: true, fiveHourTight: false }).resolve({ selection })).toMatchObject({ route: { providerId: 'a' } });
    expect(await inner({ limited: false, fiveHourTight: true }).resolve({ selection })).toMatchObject({ route: { providerId: 'a' } });
    expect(asked).toEqual(expect.arrayContaining(['a', 'b']));
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

  // model-groups.md §3.1、§6.3：另一台电脑的「其他电脑」段选了这台的模式，Agent 在这台为它运行，
  // 只能用允许被远程调用的连接。失效后果：选到不开放的连接，那台建任务时被这台拒绝。
  it('uses only remote-callable connections when another computer runs the agent here', async () => {
    const local = { agentKind: 'codex', providerId: 'b', model: 'gpt' } as const;
    // 主进程的供应商列表不带开关，由注入的判断给出(与设置里那个开关同一份)。
    const { resolver } = make(groups('order', [local, { agentKind: 'codex', providerId: 'a', model: 'gpt' }]),
      { remoteInvocable: (providerId: string) => providerId === 'a' });
    const plain = await resolver.resolve({ selection, location: { agentDeviceId: null } });
    expect(plain).toMatchObject({ outcome: 'routed', route: { providerId: 'b' } });
    const forRemote = await resolver.resolve({ selection, location: { agentDeviceId: null }, remoteInvocableOnly: true });
    expect(forRemote).toMatchObject({ outcome: 'routed', route: { providerId: 'a' } });
    expect(forRemote.trace[0]).toMatchObject({ state: 'skipped', why: 'unavailable' });
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

/**
 * 2026-11-21 裁决新增的三种选法与时段例外按星期(model-groups.md §3、§3.2)。
 * 最小失败输入：用完再换在上一次的来源还能用时换走，或前面的恢复后换回去；余量最多的先用拿 5 小时窗口压过周额度；
 * 按权重 3:1 连着给同一个来源、或没采用的选路也推进计数；周五 23:00–08:00 漏掉周六凌晨或算进周五凌晨；
 * 旧手机收到认不出的选法整条模式不列。
 */
describe('strategies added on 2026-11-21', () => {
  const key = (providerId: string) => `codex\u0000${providerId}\u0000gpt`;

  it.each([
    ['keeps the last source while it still has quota, even when an earlier one has more', 'b', FACTS, 1, 'drain'],
    ['moves on to the next one only after the last one runs out', 'b', [FACTS[0], fact([week(100, 20)]), fact(null)], 2, 'drainNext'],
    ['wraps to the start when the last one was at the end of the list', 'api', [FACTS[0], FACTS[1], fact(null, false)], 0, 'drainNext'],
    ['starts with the first usable source when nothing was used before', undefined, FACTS, 0, 'drain'],
  ] as const)('drain %s', (_name, last, facts, index, why) => {
    const picked = pickModelGroupCandidate(route('drain'), facts, { now: NOW, lastPickedKey: last ? key(last) : null });
    expect(picked.index).toBe(index);
    expect(picked.trace[index]).toMatchObject({ state: 'picked', why });
  });

  it('headroom picks the largest share left, by the weekly window when there is one, and says how much is left', () => {
    // a 周额度还剩 74%(5 小时窗口用了 90% 不算)；b 还剩 61%；api 读不到，排在后面。
    const facts = [fact([week(26, 100), fiveHour(90, 2)]), fact([week(39, 20)]), fact(null)];
    const picked = pickModelGroupCandidate(route('headroom'), facts, { now: NOW });
    expect(picked.index).toBe(0);
    expect(picked.trace[0]).toMatchObject({ why: 'headroom', quota: { usedPercent: 26, windowMs: WEEK } });
    // 只有 5 小时窗口的按它比；一样多时保留列表靠前的。
    const short = pickModelGroupCandidate(route('headroom'), [fact([fiveHour(50, 2)]), fact([fiveHour(20, 2)]), fact([fiveHour(20, 1)])], { now: NOW });
    expect(short.index).toBe(1);
    // 谁都读不到额度：按列表顺序取第一个，不说它余量最多。
    const unknown = pickModelGroupCandidate(route('headroom'), [fact(null), fact(null), fact(null)], { now: NOW });
    expect(unknown.trace[0]).toMatchObject({ state: 'picked', why: 'order' });
  });

  it('weighted interleaves new tasks by weight and only counts picks that were adopted', async () => {
    const groups: ModelGroupsConfig = { routes: [{ id: 'r1', name: 'R', strategy: 'weighted', candidates: [
      { agentKind: 'codex', providerId: 'a', model: 'gpt', weight: 3 },
      { agentKind: 'codex', providerId: 'b', model: 'gpt' },
      // 没有连接：不参与分配。
      { agentKind: 'codex', providerId: 'api', model: 'gpt', weight: 1000 },
    ] }] };
    const view = (id: string) => ({
      id, name: id, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
      models: { codex: [{ id: 'gpt', name: 'GPT', mode: 'chat', efforts: [] }] },
    }) as unknown as ProviderView;
    const resolver = createModelGroupResolver({
      config: () => groups, views: async () => [view('a'), view('b')], agents: () => ['codex'],
      harnessInstalled: async () => true, quotaWindows: async () => new Map(), scope: () => 'owner', now: () => NOW,
    });
    const selection = { type: 'route', id: 'r1' } as const;
    const picks: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      // 预览与没采用的选路不推进计数。
      await resolver.resolve({ selection, dryRun: true });
      await resolver.resolve({ selection });
      const adopted = await resolver.resolve({ selection });
      resolver.commit(adopted.decisionId!);
      if (adopted.outcome === 'routed') picks.push(adopted.route.providerId);
    }
    expect(picks.join('')).toBe('aabaaaba');
    expect(picks.filter((id) => id === 'a')).toHaveLength(6);
    // 两个新任务先后选路、再先后采用：两次都算进去，第三个照样轮到 b。
    const one = await resolver.resolve({ selection });
    const two = await resolver.resolve({ selection });
    resolver.commit(one.decisionId!);
    resolver.commit(two.decisionId!);
    const three = await resolver.resolve({ selection });
    expect([one, two, three].map((r) => r.outcome === 'routed' && r.route.providerId)).toEqual(['a', 'a', 'b']);
  });

  it('weighted starts over when the weights change, and drops a pick made under the old weights', async () => {
    const withWeights = (a: number, b: number): ModelGroupsConfig => ({ routes: [{ id: 'r1', name: 'R', strategy: 'weighted', candidates: [
      { agentKind: 'codex', providerId: 'a', model: 'gpt', weight: a },
      { agentKind: 'codex', providerId: 'b', model: 'gpt', weight: b },
    ] }] });
    let groups = withWeights(1000, 1);
    const view = (id: string) => ({
      id, name: id, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
      models: { codex: [{ id: 'gpt', name: 'GPT', mode: 'chat', efforts: [] }] },
    }) as unknown as ProviderView;
    const resolver = createModelGroupResolver({
      config: () => groups, views: async () => [view('a'), view('b')], agents: () => ['codex'],
      harnessInstalled: async () => true, quotaWindows: async () => new Map(), scope: () => 'owner', now: () => NOW,
    });
    const selection = { type: 'route', id: 'r1' } as const;
    const adopt = async () => {
      const result = await resolver.resolve({ selection });
      resolver.commit(result.decisionId!);
      return result.outcome === 'routed' ? result.route.providerId : '';
    };
    for (let i = 0; i < 20; i += 1) await adopt();
    // 按旧比例选好、还没采用时改成 1:1：这一步不记进新计数。
    const stale = await resolver.resolve({ selection });
    groups = withWeights(1, 1);
    resolver.commit(stale.decisionId!);
    const picks: string[] = [];
    for (let i = 0; i < 4; i += 1) picks.push(await adopt());
    expect(picks.join('')).toBe('abab');
  });

  it('sends phones and other computers a reason they already know, with the real one alongside', () => {
    const entry = { agentKind: 'codex', providerId: 'a', model: 'gpt', modelName: 'GPT', sourceName: 'A', quota: null } as const;
    const result: ModelGroupResolveResult = {
      outcome: 'routed', groupName: 'G', route: { agentKind: 'codex', providerId: 'a', model: 'gpt' },
      modelName: 'GPT', sourceName: 'A', why: 'drainNext', quota: null,
      trace: [{ ...entry, state: 'picked', why: 'drainNext' }, { ...entry, providerId: 'b', state: 'standby', why: 'standby' }],
    };
    const wire = JSON.parse(JSON.stringify(modelGroupResolveResultForRemote(result)));
    expect([wire.why, wire.pickWhy, wire.trace[0].why, wire.trace[0].pickWhy, wire.trace[1].pickWhy])
      .toEqual(['order', 'drainNext', 'order', 'drainNext', undefined]);
    expect(modelGroupResolveResultFromRemote(wire)).toEqual(result);
  });

  // 2026-11-11 是星期三(本机时区)，13 日星期五，14 日星期六。
  const on = (day: number, hour: number) => new Date(2026, 10, day, hour, 30).getTime();
  const friNight = [{ when: { type: 'hours', from: 23, to: 8, days: [5] }, use: { type: 'route', routeId: 'r2' } }];
  const twoRoutes = (exceptions: unknown): ModelGroupsConfig => normalizeModelGroupsConfig({ routes: [
    { ...route('order'), exceptions },
    { id: 'r2', name: '周末', strategy: 'order', candidates: [{ agentKind: 'codex', providerId: 'b', model: 'gpt' }] },
  ] });

  it.each([
    ['Friday late evening', 13, 23, 'b'],
    ['the small hours of Saturday, which belong to Friday night', 14, 2, 'b'],
    ['the small hours of Friday, which belong to Thursday night', 13, 2, 'a'],
    ['Wednesday late evening', 11, 23, 'a'],
  ] as const)('an hours exception limited to Fridays applies on %s', async (_name, day, hour, providerId) => {
    const view = (id: string) => ({
      id, name: id, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
      models: { codex: [{ id: 'gpt', name: 'GPT', mode: 'chat', efforts: [] }] },
    }) as unknown as ProviderView;
    const resolver = createModelGroupResolver({
      config: () => twoRoutes(friNight), views: async () => [view('a'), view('b')], agents: () => ['codex'],
      harnessInstalled: async () => true, quotaWindows: async () => new Map(), scope: () => 'owner', now: () => on(day, hour),
    });
    expect(await resolver.resolve({ selection: { type: 'route', id: 'r1' }, dryRun: true })).toMatchObject({ route: { providerId } });
  });

  it('saves weights and weekdays in their bounds and drops the ones that mean the default', () => {
    const saved = twoRoutes([
      { when: { type: 'hours', from: 23, to: 8, days: [6, 5, 5, 9, 'x'] }, use: { type: 'route', routeId: 'r2' } },
      { when: { type: 'hours', from: 9, to: 18, days: [0, 1, 2, 3, 4, 5, 6] }, use: { type: 'route', routeId: 'r2' } },
      { when: { type: 'hours', from: 9, to: 18, days: [] }, use: { type: 'route', routeId: 'r2' } },
    ]);
    expect(saved.routes[0].exceptions?.map((item) => item.when)).toEqual([
      { type: 'hours', from: 23, to: 8, days: [5, 6] },
      { type: 'hours', from: 9, to: 18 },
      { type: 'hours', from: 9, to: 18 },
    ]);
    const weights = normalizeModelGroupsConfig({ routes: [{ id: 'w', name: 'W', strategy: 'weighted', candidates: [
      { agentKind: 'codex', providerId: 'a', model: 'gpt', weight: 2.6 },
      { agentKind: 'codex', providerId: 'b', model: 'gpt', weight: 5000 },
      { agentKind: 'codex', providerId: 'c', model: 'gpt', weight: 1 },
      { agentKind: 'codex', providerId: 'd', model: 'gpt', weight: 'heavy' },
    ] }] });
    expect(weights.routes[0].candidates.map((item) => item.weight)).toEqual([3, 1000, undefined, undefined]);
  });

  it('sends phones and other computers a strategy they already know, with the real one alongside', () => {
    const config = normalizeModelGroupsConfig({ routes: [route('drain'), { ...route('order'), id: 'r2' }] });
    const wire = modelGroupsConfigForRemote(config);
    expect(wire.routes.map((item) => [item.strategy, (item as { pick?: string }).pick])).toEqual([['order', 'drain'], ['order', undefined]]);
    // 新版读回来是真实的选法。
    expect(normalizeModelGroupsConfig(JSON.parse(JSON.stringify(wire))).routes.map((item) => item.strategy)).toEqual(['drain', 'order']);
  });
});

// model-groups.md §4.5 (2026-11-24): each mode has its own 「出问题时自动换来源」, on unless the user turned it off;
// a task follows the switch of the mode it was opened with.
describe('auto switch setting', () => {
  it.each([
    ['never set', {}, true, undefined],
    ['turned off', { autoSwitch: false }, false, false],
    ['a stray true', { autoSwitch: true }, true, undefined],
    ['junk', { autoSwitch: 'no' }, true, undefined],
  ] as const)('reads a mode with %s', (_name, extra, on, stored) => {
    const [saved] = normalizeModelGroupsConfig({ routes: [{ ...route('order'), ...extra }] }).routes;
    expect(modelGroupAutoSwitchOn(saved)).toBe(on);
    expect(saved.autoSwitch).toBe(stored);
  });

  it('follows the mode the task was opened with, and stops once that mode is gone', () => {
    const config = normalizeModelGroupsConfig({ routes: [route('order'), { ...route('order'), id: 'r2', autoSwitch: false }] });
    expect(modelGroupAutoSwitchFor(config, { type: 'route', id: 'r1' })).toBe(true);
    expect(modelGroupAutoSwitchFor(config, { type: 'route', id: 'r2' })).toBe(false);
    expect(modelGroupAutoSwitchFor(config, { type: 'route', id: 'gone' })).toBe(false);
  });
});

// 2026-11-25 用户反馈(打开设置页，余量要晚两秒才出现) / unit：界面显示余量时请求带 cachedQuota，读额度那一步要被告知
// 「用手头的读数，不等新的」；真正给任务选来源(不带)时不能带上它。真实入口：createModelGroupResolver().resolve。
// 失效后果：显示每次都等满上限，或真选路改按旧读数选。最小输入：一条路由、一个来源。
it('asks for the quota readings on hand only when the request is for display', async () => {
  const groups = { routes: [{ id: 'r1', name: 'R', strategy: 'order', candidates: [{ agentKind: 'codex', providerId: 'a', model: 'gpt' }] }] } as ModelGroupsConfig;
  const view = {
    id: 'a', name: 'a', source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: [{ id: 'gpt', name: 'GPT', mode: 'chat', efforts: [] }] },
  } as unknown as ProviderView;
  const quotaWindows = vi.fn(async (_options?: { cached?: boolean }) => new Map<string, ModelGroupTraceQuota[]>());
  const resolver = createModelGroupResolver({
    config: () => groups, views: async () => [view], agents: () => ['codex'],
    harnessInstalled: async () => true, quotaWindows, scope: () => 'owner', now: () => NOW,
  });
  const selection = { type: 'route', id: 'r1' } as const;
  await resolver.resolve({ selection, dryRun: true, cachedQuota: true });
  await resolver.resolve({ selection, dryRun: true });
  await resolver.resolve({ selection });
  expect(quotaWindows.mock.calls.map(([options]) => options?.cached === true)).toEqual([true, false, false]);
});

it('resolves SSH native Codex candidates from the SSH host catalog without local openai login or local codex install', async () => {
  const sshCodexProvider = {
    id: 'openai',
    name: 'Codex',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    routing: { codex: { upstream: 'https://chatgpt.com/backend-api/codex', authStrategy: 'oauth-passthrough' } },
    models: { codex: [{ id: 'gpt-5.5', name: 'GPT-5.5', mode: 'chat', efforts: ['high'] }] },
  } as unknown as ProviderView;
  const groups = {
    routes: [{
      id: 'r-ssh',
      name: 'SSH Route',
      strategy: 'order',
      effort: 'high',
      candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-5.5' }],
    }],
  } as ModelGroupsConfig;
  const { sshFilter, sshCodexViews } = createSshModelGroupSupport({
    listSshCodexProviders: async (hostId) => (hostId === 'ssh-1' ? [sshCodexProvider] : []),
    now: () => NOW,
  });
  const resolver = createModelGroupResolver({
    config: () => groups,
    views: async () => [],
    agents: () => [],
    harnessInstalled: async () => false,
    quotaWindows: async () => new Map(),
    scope: () => 'owner',
    now: () => NOW,
    sshFilter,
    sshCodexViews,
  });
  const routed = await resolver.resolve({ selection: { type: 'route', id: 'r-ssh' }, sshHostId: 'ssh-1' });
  expect(routed).toMatchObject({
    outcome: 'routed',
    route: { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.5', effort: 'high' },
  });
  const missing = await resolver.resolve({ selection: { type: 'route', id: 'r-ssh' }, sshHostId: 'ssh-empty' });
  expect(missing).toMatchObject({ outcome: 'unavailable' });
});

// 2026-11-28 用户裁决：拆平后的单账号候选直接按各自独立配额窗口解析，不走 innerQuota 二次包裹，
// 预览 trace 逐个展示账号名与余量，并把选中的 accountId 带回 route。
// 失效后果：试一下出来被包裹的 auto 或两个账号读成同一份配额。
// 最小输入：一条带 parent 的展开路由，包含本机 openai 的 default 与 second 两个账号及一个 BYOK 来源。
it('resolves flattened per-account candidates with individual quotas without invoking innerQuota', async () => {
  const innerQuota = vi.fn(async () => ({ limited: true, urgency: null, fiveHourTight: false, headroom: 0 }));
  const view = (id: string, name: string) => ({
    id, name, source: 'builtin', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: [{ id: 'gpt-6.2', name: 'GPT-6.2', mode: 'chat', efforts: ['high'] }] },
  }) as unknown as ProviderView;
  const route: ModelGroupRoute = {
    id: 'src:test-flat',
    name: 'GPT-6.2',
    strategy: 'expiring',
    parent: { id: 'auto:openai', name: 'OpenAI' },
    candidates: [
      { agentKind: 'codex', providerId: 'openai', accountId: 'default', model: 'gpt-6.2' },
      { agentKind: 'codex', providerId: 'openai', accountId: 'second', model: 'gpt-6.2' },
      { agentKind: 'codex', providerId: 'byok-1', model: 'gpt-6.2' },
    ],
  };
  const resolver = createModelGroupResolver({
    config: () => ({ routes: [route] }),
    views: async () => [view('openai', 'OpenAI'), view('byok-1', 'OpenAI-Codex')],
    agents: () => ['codex'],
    harnessInstalled: async () => true,
    localAccount: (_providerId, accountId) => (
      accountId === 'default'
        ? { available: true, label: 'first@example.com' }
        : accountId === 'second'
          ? { available: true, label: 'second@example.com' }
          : null
    ),
    quotaWindows: async () => new Map([
      // default 已满额，second 还剩 80%：应直接选中 second，不调用 innerQuota。
      [modelGroupQuotaKey(undefined, 'openai', 'default'), [{ usedPercent: 100, resetAtMs: NOW + HOUR, windowMs: 5 * HOUR }]],
      [modelGroupQuotaKey(undefined, 'openai', 'second'), [{ usedPercent: 20, resetAtMs: NOW + 2 * HOUR, windowMs: 5 * HOUR }]],
    ]),
    innerQuota,
    scope: () => 'owner',
    now: () => NOW,
  });

  const result = await resolver.resolve({ selection: { type: 'route', id: 'src:test-flat' }, dryRun: true });
  expect(innerQuota).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    outcome: 'routed',
    route: { agentKind: 'codex', providerId: 'openai', accountId: 'second', model: 'gpt-6.2' },
    sourceName: 'OpenAI · second@example.com',
  });
  expect(result.trace.map((entry) => [entry.accountId ?? null, entry.sourceName, entry.state, entry.why])).toEqual([
    ['default', 'OpenAI · first@example.com', 'skipped', 'limited'],
    ['second', 'OpenAI · second@example.com', 'picked', 'expiring'],
    [null, 'OpenAI-Codex', 'standby', 'standby'],
  ]);
});

// Unit through actual resolver/preview: a held standalone Key or individual
// pool member is not a selectable automatic assignment for the chosen engine.
it('skips held standalone and account-qualified Keys before preview or dispatch', async () => {
  const providers = ['openai', 'key'].map(id => ({ id, name: id, source: 'builtin', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: [{ id: 'gpt', name: 'GPT', mode: 'chat', efforts: [] }] },
  })) as unknown as ProviderView[];
  const group: ModelGroupRoute = { id: 'r-preserved', name: 'Saved', strategy: 'order', candidates: [
    { agentKind: 'codex', providerId: 'key', model: 'gpt' },
    { agentKind: 'codex', providerId: 'openai', accountId: 'held-key', model: 'gpt' }, { agentKind: 'codex', providerId: 'openai', accountId: 'native', model: 'gpt', weight: 5 },
  ] };
  let held = true;
  const localAccount = vi.fn((_providerId: string, accountId: string, _model: string, agent: string) => ({ available: accountId !== 'held-key' || !held || agent !== 'codex', label: accountId }));
  const resolver = createModelGroupResolver({ config: () => ({ routes: [group] }), views: async () => providers, agents: () => ['codex'], harnessInstalled: async () => true,
    quotaWindows: async () => new Map(), scope: () => 'owner', now: () => NOW, localCandidateAvailable: provider => provider.id !== 'key' || !held, localAccount });
  const selection = { type: 'route', id: group.id } as const;
  for (const dryRun of [true, false]) expect(await resolver.resolve({ selection, dryRun })).toMatchObject({ outcome: 'routed', route: { providerId: 'openai', accountId: 'native' } });
  expect(localAccount).toHaveBeenCalledWith('openai', 'held-key', 'gpt', 'codex');
  group.candidates[2].off = true;
  expect(await resolver.resolve({ selection, dryRun: true })).toMatchObject({ outcome: 'unavailable' });
  held = false;
  expect(await resolver.resolve({ selection, dryRun: true })).toMatchObject({ outcome: 'routed', route: { providerId: 'key' } });
});
