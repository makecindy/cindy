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
 * - tier：unit，纯函数与注入依赖。
 */
import { describe, expect, it } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import {
  normalizeModelGroupsConfig,
  type ModelGroupRoute,
  type ModelGroupsConfig,
  type ModelGroupTraceQuota,
} from '../../../shared/modelGroups.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from '../pick.js';
import { createModelGroupResolver } from '../resolver.js';

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
  const config: ModelGroupsConfig = {
    routes: [route('rotate')],
    modes: [
      { id: 'm1', name: '深入', target: { type: 'route', routeId: 'r1' }, effort: 'high' },
      { id: 'm2', name: '怪档', target: { type: 'model', agentKind: 'codex', providerId: 'a', model: 'gpt' }, effort: 'xhigh' },
    ],
  };
  const make = (groups: ModelGroupsConfig = config, now = NOW) => createModelGroupResolver({
    config: () => groups,
    views: async () => [view('a', 'ChatGPT Pro'), view('b', 'ChatGPT Plus', true)],
    agents: () => ['codex'],
    harnessInstalled: async () => true,
    quotaWindows: async () => new Map([['a', [week(26, 100)]], ['b', [week(39, 20)]]]),
    scope: () => 'owner',
    now: () => now,
  });

  it('advances rotation only on a real pick, never on a dry run', async () => {
    const resolver = make();
    const selection = { type: 'route', id: 'r1' } as const;
    const first = await resolver.resolve({ selection });
    const preview = await resolver.resolve({ selection, dryRun: true });
    const second = await resolver.resolve({ selection });
    expect([first, preview, second].map((r) => r.outcome === 'routed' && r.route.providerId)).toEqual(['a', 'b', 'b']);
    // 第三个候选没有连接：轮到它时跳回第一个，并写明它为什么没被选。
    const third = await resolver.resolve({ selection });
    expect(third).toMatchObject({ outcome: 'routed', route: { providerId: 'a' }, sourceName: 'ChatGPT Pro', modelName: 'GPT-5.6' });
    expect(third.trace[2]).toMatchObject({ why: 'unavailable' });
  });

  it('applies a mode\'s thinking depth only when the picked model supports it', async () => {
    const resolver = make();
    expect(await resolver.resolve({ selection: { type: 'mode', id: 'm1' } })).toMatchObject({ outcome: 'routed', groupName: '深入', route: { effort: 'high' } });
    const unsupported = await resolver.resolve({ selection: { type: 'mode', id: 'm2' } });
    expect(unsupported.outcome === 'routed' && 'effort' in unsupported.route).toBe(false);
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
    modes: [],
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
