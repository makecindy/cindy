import { describe, expect, it } from 'vitest';
import { pickProviderGroupMember } from '../../provider-group/scheduler.js';
import { providerGroupCodexUsageSnapshot, providerGroupMemberUsageState, providerGroupMemberQuotaWindows } from '../../provider-group/usage.js';
import { pickSubscriptionAccountMember, type SubscriptionSchedulableMember } from '../scheduler.js';

// Unit regression: native pool acquisition used a quota-only 90% filter before every strategy,
// leaving an entire healthy account idle. Existing picker tests only cover provider groups.
// Minimal input: one weekly-only account and one 5h+weekly account, two independent ready jobs.
// Percentages below are independent provider snapshots, never inferred from job/token counts.
const NOW = Date.parse('2026-11-14T10:00:00Z');
const HOUR = 3_600_000;
const policies = ['least', 'round', 'order', 'weight', 'usage'] as const;
function members(now = NOW, short = 1, week = 5, reset = NOW + 5 * HOUR): SubscriptionSchedulableMember[] {
  return ['weekly', 'short-weekly'].map((key, index) => {
    const codexUsage = providerGroupCodexUsageSnapshot({ nativeAccountPool: true, appServerBuckets: { codex: {
      updatedAt: now, primary: index ? { usedPercent: short, windowMinutes: 300, resetsAt: reset / 1000 }
        : { usedPercent: 55, windowMinutes: 10080, resetsAt: (NOW + 6 * 24 * HOUR) / 1000 },
      secondary: index ? { usedPercent: week, windowMinutes: 10080, resetsAt: (NOW + 3 * 24 * HOUR) / 1000 } : null,
    } } })!;
    const usage = providerGroupMemberUsageState({ codexUsage }, 'gpt-6', now, 'codex');
    return { key, usable: true, paused: false, running: 0, limit: index ? 4 : 10, weight: index ? 5 : 20,
      urgency: usage.urgency, fiveHourTight: usage.fiveHourTight,
      windows: providerGroupMemberQuotaWindows({ codexUsage }, 'gpt-6', now, 'codex') };
  });
}

describe('native account useful-work coverage', () => {
  it.each(policies)('both accounts contribute under sustained independent load with %s', policy => {
    const pool = members();
    expect(pickProviderGroupMember(pool, policy, { random: () => 0 })).toBe('short-weekly');
    const completed = { weekly: 0, 'short-weekly': 0 };
    // 100 batches of two useful independent jobs; start-before-complete reserves the actual load.
    for (let batch = 0; batch < 100; batch++) {
      for (let job = 0; job < 2; job++) {
        const key = pickSubscriptionAccountMember(pool, policy, { random: () => 0 })!;
        pool.find(m => m.key === key)!.running++;
        completed[key as keyof typeof completed]++;
      }
      expect(pool.map(m => m.running)).toEqual([1, 1]);
      for (const member of pool) member.running = 0;
    }
    expect(completed).toEqual({ weekly: 100, 'short-weekly': 100 });
  });

  it('avoids a tight short window and resumes participation only after a fresh reset snapshot', () => {
    const checkpoints = [
      { at: NOW, short: 1, reset: NOW + 5 * HOUR, contributes: true },
      { at: NOW + HOUR, short: 86, reset: NOW + 5 * HOUR, contributes: false },
      { at: NOW + 4.5 * HOUR, short: 100, reset: NOW + 5 * HOUR, contributes: false },
      { at: NOW + 5 * HOUR, short: 100, reset: NOW + 5 * HOUR, contributes: false },
      { at: NOW + 5 * HOUR + 1000, short: 0, reset: NOW + 10 * HOUR, contributes: true },
      { at: NOW + 9 * HOUR, short: 90, reset: NOW + 10 * HOUR, contributes: false },
      { at: NOW + 10 * HOUR + 1000, short: 0, reset: NOW + 15 * HOUR, contributes: true },
    ];
    for (const checkpoint of checkpoints) {
      const pool = members(checkpoint.at, checkpoint.short, 20, checkpoint.reset);
      const chosen = new Set<string>();
      for (let job = 0; job < 2; job++) {
        const key = pickSubscriptionAccountMember(pool, 'least')!;
        chosen.add(key); pool.find(m => m.key === key)!.running++;
      }
      expect(chosen.has('weekly')).toBe(true);
      expect(chosen.has('short-weekly')).toBe(checkpoint.contributes);
    }
    expect(pickSubscriptionAccountMember(members(NOW, 0, 100), 'least')).toBe('weekly');
    const tight = members(NOW, 100, 5, NOW + 60_000);
    tight[0].windows![0].usedPercent = 96;
    expect(pickSubscriptionAccountMember(tight, 'least')).toBe('weekly');
  });

  it('respects account caps, pause, auth and model eligibility before providing coverage', () => {
    for (const reason of ['full', 'paused', 'unavailable'] as const) {
      const pool = members();
      if (reason === 'full') pool[1].running = pool[1].limit;
      if (reason === 'paused') pool[1].paused = true;
      if (reason === 'unavailable') pool[1].usable = false;
      expect(pickSubscriptionAccountMember(pool, 'least')).toBe('weekly');
    }
    const pool = members(); pool.forEach(m => { m.running = m.limit; });
    expect(pickSubscriptionAccountMember(pool, 'least')).toBeNull();
  });
});
