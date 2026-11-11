/**
 * 测试价值
 * - 生产入口与可观察结果：pickModelGroupCandidate / createModelGroupResolver.resolve——新任务最终用哪个来源、
 *   以及任务里写给用户的原因。
 * - 规则依据：docs/product-rules/model-groups.md §3 选法、§4 用不了时。
 * - 现有覆盖缺口：供应商组的排序只覆盖「同一供应商的多台电脑」，不覆盖跨来源候选、停用、未连接与全部撞限。
 * - 最小失败输入：两个订阅一个周额度明天重置、一个周日重置；选错即把快作废的额度留到作废。
 * - tier：unit，纯函数与注入依赖。
 */
import { describe, expect, it } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

import type { ModelGroupRoute, ModelGroupsConfig, ModelGroupTraceQuota } from '../../../shared/modelGroups.js';
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

  it('picks nothing when no source is connected', () => {
    const picked = pickModelGroupCandidate(route('expiring'), [fact(null, false), fact(null, false), fact(null, false)], { now: NOW });
    expect(picked.index).toBeNull();
  });
});

describe('createModelGroupResolver', () => {
  const view = (id: string, name: string) => ({
    id, name, source: 'user', connected: true, agents: ['codex'], routing: { codex: { enabled: true } },
    models: { codex: [{ id: 'gpt', name: 'GPT-5.6', mode: 'chat', efforts: ['low', 'high'] }] },
  }) as unknown as ProviderView;
  const config: ModelGroupsConfig = {
    routes: [route('rotate')],
    modes: [
      { id: 'm1', name: '深入', target: { type: 'route', routeId: 'r1' }, effort: 'high' },
      { id: 'm2', name: '怪档', target: { type: 'model', agentKind: 'codex', providerId: 'a', model: 'gpt' }, effort: 'xhigh' },
    ],
  };
  const make = () => createModelGroupResolver({
    config: () => config,
    views: async () => [view('a', 'ChatGPT Pro'), view('b', 'ChatGPT Plus')],
    agents: () => ['codex'],
    harnessInstalled: async () => true,
    quotaWindows: async () => new Map([['a', [week(26, 100)]], ['b', [week(39, 20)]]]),
    scope: () => 'owner',
    now: () => NOW,
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
});
