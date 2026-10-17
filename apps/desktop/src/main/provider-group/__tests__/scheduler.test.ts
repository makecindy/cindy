/**
 * 组策略(provider-groups.md §5)：只分给可用、未暂停、没试过的电脑；优先未满载。
 */
import { describe, expect, it } from 'vitest';

import type { ProviderGroupStrategy } from '../../../shared/providerGroup';
import {
  pickProviderGroupMember,
  PROVIDER_GROUP_FIVE_HOUR_EXPIRING_MS,
  PROVIDER_GROUP_SAME_RESET_MS,
  PROVIDER_GROUP_WEEKLY_EXPIRING_MS,
  type SchedulableMember,
} from '../scheduler';

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

  it('prefers computers under their limit and falls back to the least busy when all are full', () => {
    const members = [m('a', { running: 4 }), m('b', { running: 3 })];
    expect(pickProviderGroupMember(members, 'order')).toBe('b');
    expect(pickProviderGroupMember([m('a', { running: 5 }), m('b', { running: 4 })], 'order')).toBe('b');
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

  it('balances current usage and spreads similar usage across idle computers', () => {
    expect(pickProviderGroupMember([m('a', { usagePercent: 85 }), m('b', { usagePercent: 55, running: 2 })], 'usage')).toBe('b');
    expect(pickProviderGroupMember([m('a', { usagePercent: 40, running: 2 }), m('b', { usagePercent: 45 })], 'usage')).toBe('b');
    expect(pickProviderGroupMember([m('a', { usagePercent: 40, running: 2 }), m('b', { usagePercent: 46 })], 'usage')).toBe('a');
  });

  it('uses known usage first, with ordinary load balancing when no current usage is known', () => {
    expect(pickProviderGroupMember([m('unknown'), m('known', { usagePercent: 80 })], 'usage')).toBe('known');
    expect(pickProviderGroupMember([m('a', { running: 1 }), m('b', { usagePercent: null })], 'usage')).toBe('b');
    expect(pickProviderGroupMember([m('a', { usagePercent: 10, usable: false })], 'usage')).toBeNull();
  });

  it('keeps concurrency limits ahead of usage ranking, including the all-full fallback', () => {
    const full = m('low', { usagePercent: 10, running: 4 });
    expect(pickProviderGroupMember([full, m('high', { usagePercent: 80 })], 'usage')).toBe('high');
    expect(pickProviderGroupMember([full, m('other', { usagePercent: 5, running: 5 })], 'usage')).toBe('low');
  });
});

describe('quota about to reset is used first', () => {
  const NOW = 10_000_000_000;
  const HOUR = 60 * 60_000;
  const pick = (members: SchedulableMember[], strategy: ProviderGroupStrategy = 'usage') =>
    pickProviderGroupMember(members, strategy, { now: NOW });

  it('prefers weekly quota resetting within 5 hours over lower usage, earliest reset first', () => {
    const idle = m('idle', { usagePercent: 5 });
    expect(pick([idle, m('weekly', { usagePercent: 70, weeklyResetAtMs: NOW + 4 * HOUR })])).toBe('weekly');
    expect(pick([idle, m('weekly', { usagePercent: 70, weeklyResetAtMs: NOW + PROVIDER_GROUP_WEEKLY_EXPIRING_MS + 1 })]))
      .toBe('idle');
    expect(pick([
      idle,
      m('later', { usagePercent: 10, weeklyResetAtMs: NOW + 4 * HOUR }),
      m('sooner', { usagePercent: 90, weeklyResetAtMs: NOW + 2 * HOUR }),
    ])).toBe('sooner');
  });

  it('ranks the weekly tier ahead of the 5-hour tier, which only counts its last hour', () => {
    const fiveHour = m('five-hour', { usagePercent: 20, fiveHourResetAtMs: NOW + 10 * 60_000 });
    const weekly = m('weekly', { usagePercent: 60, weeklyResetAtMs: NOW + 3 * HOUR });
    expect(pick([fiveHour, weekly])).toBe('weekly');
    const idle = m('idle', { usagePercent: 5 });
    expect(pick([idle, fiveHour])).toBe('five-hour');
    expect(pick([idle, m('five-hour', { usagePercent: 20, fiveHourResetAtMs: NOW + PROVIDER_GROUP_FIVE_HOUR_EXPIRING_MS + 1 })]))
      .toBe('idle');
  });

  it('balances computers that expire at nearly the same time', () => {
    const reset = NOW + 30 * 60_000;
    const sameTime = [
      m('a', { usagePercent: 40, running: 2, fiveHourResetAtMs: reset }),
      m('b', { usagePercent: 42, fiveHourResetAtMs: reset + PROVIDER_GROUP_SAME_RESET_MS }),
    ];
    expect(pick(sameTime)).toBe('b');
    expect(pick([sameTime[0], { ...sameTime[1], fiveHourResetAtMs: reset + PROVIDER_GROUP_SAME_RESET_MS + 1 }])).toBe('a');
  });

  it('keeps concurrency limits ahead of expiring quota and ignores past or unknown resets', () => {
    const fullExpiring = m('full', { usagePercent: 10, running: 4, weeklyResetAtMs: NOW + HOUR });
    expect(pick([fullExpiring, m('open', { usagePercent: 80 })])).toBe('open');
    // 都满了时仍然先用快到期的，而不是单看谁更空。
    expect(pick([m('emptier', { usagePercent: 10, running: 4 }), { ...fullExpiring, key: 'expiring', running: 6 }])).toBe('expiring');
    expect(pick([m('past', { usagePercent: 80, weeklyResetAtMs: NOW }), m('low', { usagePercent: 10 })])).toBe('low');
    expect(pickProviderGroupMember([m('low', { usagePercent: 10 }), m('soon', { usagePercent: 80, weeklyResetAtMs: NOW + HOUR })], 'usage'))
      .toBe('low');
  });

  it.each(['least', 'order', 'round', 'weight'] as const)('comes before the %s strategy', (strategy) => {
    expect(pick([m('a', { usagePercent: 10 }), m('soon', { usagePercent: 80, running: 1, weeklyResetAtMs: NOW + HOUR })], strategy)).toBe('soon');
  });

  it.each(['least', 'usage', 'order', 'round', 'weight'] as const)(
    'keeps incomplete usage behind known usage before comparing reset times for %s', (strategy) => {
      const members = [
        m('unknown', { usagePercent: null, weeklyResetAtMs: NOW + 2 * HOUR }),
        m('known', { usagePercent: 80, running: 1 }),
      ];
      expect(pick(members, strategy)).toBe('known');
      expect(pick(members.map((member) => ({ ...member, running: member.running + 4 })), strategy)).toBe('known');
    },
  );

  it('ignores reset times and keeps the original strategies when every usage reading is incomplete', () => {
    const members = [
      m('first', { usagePercent: null, running: 1 }),
      m('expiring', { weeklyResetAtMs: NOW + 2 * HOUR }),
    ];
    expect(pick(members, 'order')).toBe('first');
    expect(pick(members, 'least')).toBe('expiring');
    expect(pick(members, 'usage')).toBe('expiring');
    expect(pickProviderGroupMember(members, 'round', { now: NOW, lastPicked: 'expiring' })).toBe('first');
    expect(pickProviderGroupMember(members, 'weight', { now: NOW, random: () => 0 })).toBe('first');
  });
});

describe('quota comes first for every strategy; the strategy picks among similar computers', () => {
  it.each(['least', 'order', 'round', 'weight'] as const)('sends %s picks to the lower-usage computer', (strategy) => {
    expect(pickProviderGroupMember([m('busy-quota', { usagePercent: 80 }), m('spare', { usagePercent: 10, running: 3 })], strategy, {
      lastPicked: 'spare', random: () => 0,
    })).toBe('spare');
  });

  it('lets each strategy choose within the 5-point band', () => {
    const similar = [
      m('a', { usagePercent: 12, running: 2, weight: 1 }),
      m('b', { usagePercent: 10, running: 1, weight: 3 }),
      m('c', { usagePercent: 14, weight: 1 }),
      m('far', { usagePercent: 40 }),
    ];
    expect(pickProviderGroupMember(similar, 'order')).toBe('a');
    expect(pickProviderGroupMember(similar, 'least')).toBe('c');
    expect(pickProviderGroupMember(similar, 'usage')).toBe('c');
    expect(pickProviderGroupMember(similar, 'round', { lastPicked: 'a' })).toBe('b');
    expect(pickProviderGroupMember(similar, 'round', { lastPicked: 'c' })).toBe('a');
    expect(pickProviderGroupMember(similar, 'weight', { random: () => 0.5 })).toBe('b');
  });

  it('puts computers without readable usage after known ones, and keeps plain strategies when none is known', () => {
    expect(pickProviderGroupMember([m('shared'), m('own', { usagePercent: 90, running: 3 })], 'order')).toBe('own');
    expect(pickProviderGroupMember([m('a', { running: 1 }), m('b')], 'order')).toBe('a');
    expect(pickProviderGroupMember([m('a', { running: 1 }), m('b')], 'least')).toBe('b');
  });
});
