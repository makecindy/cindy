/**
 * 组策略(provider-groups.md §5)：只分给可用、未暂停、没试过、未满载的电脑；最急着用的额度先用。
 */
import { describe, expect, it } from 'vitest';

import {
  concurrencyLimitOptionValue,
  concurrencyLimitPatch,
  effectiveConcurrencyLimit,
  normalizeProviderGroupConfig,
  PROVIDER_GROUP_STRATEGIES,
} from '../../../shared/providerGroup';
import { pickProviderGroupMember, providerGroupMembersFull, type SchedulableMember } from '../scheduler';

const m = (key: string, patch: Partial<SchedulableMember> = {}): SchedulableMember => ({
  key,
  usable: true,
  paused: false,
  running: 0,
  limit: 4,
  weight: 1,
  ...patch,
});

describe('pickProviderGroupMember', () => {
  it('skips unusable, paused and already-tried computers', () => {
    const members = [m('a', { usable: false }), m('b', { paused: true }), m('c'), m('d')];
    expect(pickProviderGroupMember(members, 'order')).toBe('c');
    expect(pickProviderGroupMember(members, 'order', { exclude: new Set(['c']) })).toBe('d');
    expect(pickProviderGroupMember(members, 'order', { exclude: new Set(['c', 'd']) })).toBeNull();
  });

  it('least busy picks the computer running the fewest tasks, ties by list order', () => {
    expect(pickProviderGroupMember([m('a', { running: 2 }), m('b', { running: 1 }), m('c', { running: 1 })], 'least')).toBe('b');
  });

  // 2026-11-11 用户裁决：达到并发上限就不再分新任务(取代「都满了时分给最空的」)。
  it('assigns only computers under their limit and reports when every candidate is full', () => {
    const members = [m('a', { running: 4 }), m('b', { running: 3 })];
    expect(pickProviderGroupMember(members, 'order')).toBe('b');
    const full = [m('a', { running: 5 }), m('b', { running: 4 }), m('off', { usable: false })];
    expect(pickProviderGroupMember(full, 'order')).toBeNull();
    expect(providerGroupMembersFull(full)).toBe(true);
    // 没有能接的电脑不是满载；排除掉唯一未满的那台后才算满载。
    expect(providerGroupMembersFull([m('off', { usable: false })])).toBe(false);
    expect(providerGroupMembersFull([m('a', { running: 4 }), m('b')], { exclude: new Set(['b']) })).toBe(true);
  });

  it('never fills a computer whose limit is unlimited', () => {
    const members = [m('a', { running: 100, limit: Number.POSITIVE_INFINITY }), m('b', { running: 4 })];
    expect(pickProviderGroupMember(members, 'order')).toBe('a');
    expect(providerGroupMembersFull(members)).toBe(false);
  });

  it('round robin continues after the last picked computer and wraps around', () => {
    const members = [m('a'), m('b'), m('c')];
    expect(pickProviderGroupMember(members, 'round', { lastPicked: null })).toBe('a');
    expect(pickProviderGroupMember(members, 'round', { lastPicked: 'a' })).toBe('b');
    expect(pickProviderGroupMember(members, 'round', { lastPicked: 'c' })).toBe('a');
  });

  it('weight splits by the given weights', () => {
    const members = [m('a', { weight: 1 }), m('b', { weight: 3 })];
    expect(pickProviderGroupMember(members, 'weight', { random: () => 0.1 })).toBe('a');
    expect(pickProviderGroupMember(members, 'weight', { random: () => 0.5 })).toBe('b');
  });

  it('keeps concurrency limits ahead of quota urgency', () => {
    const urgent = m('urgent', { urgency: 5, running: 4 });
    expect(pickProviderGroupMember([urgent, m('calm', { urgency: 0.5 })], 'least')).toBe('calm');
    expect(pickProviderGroupMember([m('emptier', { urgency: 0.5, running: 4 }), { ...urgent, running: 6 }], 'least')).toBeNull();
  });
});

// 2026-11-11 用户裁决：没设置过并发上限的不限制；旧版存下的默认 4 视为没设置过，设置过的值照旧生效。
describe('effective concurrency limit', () => {
  it('treats unset and legacy-default limits as unlimited and keeps chosen limits', () => {
    expect(effectiveConcurrencyLimit({ limit: 4 })).toBe(Number.POSITIVE_INFINITY);
    expect(effectiveConcurrencyLimit({ limit: 4, limitSet: true })).toBe(4);
    expect(effectiveConcurrencyLimit({ limit: 8 })).toBe(8);
    expect(concurrencyLimitOptionValue({ limit: 4 })).toBe('unlimited');
    expect(concurrencyLimitOptionValue({ limit: 4, limitSet: true })).toBe('4');
  });

  it('round-trips the unlimited choice through stored group settings for old and new clients', () => {
    const member = { kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 6, limitSet: true, weight: 1, paused: false };
    const chosen = normalizeProviderGroupConfig({ strategy: 'least', autoSwitch: true,
      members: [{ ...member, ...concurrencyLimitPatch(4) }] }, 'anthropic')!;
    expect(effectiveConcurrencyLimit(chosen.members[0])).toBe(4);
    const cleared = normalizeProviderGroupConfig(JSON.parse(JSON.stringify({ ...chosen,
      members: [{ ...chosen.members[0], ...concurrencyLimitPatch(null) }] })), 'anthropic')!;
    // Old clients read the legacy default and keep their former behavior.
    expect(cleared.members[0]).toMatchObject({ limit: 4 });
    expect(cleared.members[0]).not.toHaveProperty('limitSet');
    expect(effectiveConcurrencyLimit(cleared.members[0])).toBe(Number.POSITIVE_INFINITY);
  });
});

// 2026-10-21 用户裁决：不论选哪种组策略，都先用最急着用的额度(快作废的最优先，其次各账号平均)，
// 组策略只在一样急的几台里挑。
describe('the most urgent quota comes first for every strategy', () => {
  it.each(PROVIDER_GROUP_STRATEGIES)('sends %s picks to the most urgent computer', (strategy) => {
    expect(pickProviderGroupMember([m('calm', { urgency: 1 }), m('urgent', { urgency: 4, running: 3 })], strategy, {
      lastPicked: 'urgent', random: () => 0,
    })).toBe('urgent');
  });

  it('lets each strategy choose among computers at least 90% as urgent as the most urgent one', () => {
    const similar = [
      m('far', { urgency: 1.79 }),
      m('a', { urgency: 1.9, running: 2, weight: 1 }),
      m('b', { urgency: 2, running: 1, weight: 3 }),
      m('c', { urgency: 1.8, weight: 1 }),
    ];
    expect(pickProviderGroupMember(similar, 'order')).toBe('a');
    expect(pickProviderGroupMember(similar, 'least')).toBe('c');
    expect(pickProviderGroupMember(similar, 'usage')).toBe('c');
    expect(pickProviderGroupMember(similar, 'round', { lastPicked: 'a' })).toBe('b');
    expect(pickProviderGroupMember(similar, 'round', { lastPicked: 'c' })).toBe('a');
    expect(pickProviderGroupMember(similar, 'weight', { random: () => 0.5 })).toBe('b');
  });

  it('puts computers without readable usage after known ones, and keeps plain strategies when none is known', () => {
    expect(pickProviderGroupMember([m('shared'), m('own', { urgency: 0.2, running: 3 })], 'order')).toBe('own');
    expect(pickProviderGroupMember([m('a', { running: 1 }), m('b', { urgency: null })], 'order')).toBe('a');
    expect(pickProviderGroupMember([m('a', { running: 1 }), m('b')], 'least')).toBe('b');
  });

  // 2026-10-21 用户裁决：5 小时配额快满、离重置还早的先不分新任务(刚开始就撞上限会被迫换电脑)，都是这样时照常分。
  it('avoids a nearly full 5-hour window, even ahead of urgency and of unreadable computers, unless all are like that', () => {
    const tight = m('tight', { urgency: 9, fiveHourTight: true });
    expect(pickProviderGroupMember([tight, m('calm', { urgency: 1 })], 'order')).toBe('calm');
    expect(pickProviderGroupMember([tight, m('api')], 'order')).toBe('api');
    expect(pickProviderGroupMember([tight, m('also', { urgency: 2, fiveHourTight: true })], 'order')).toBe('tight');
  });
});
