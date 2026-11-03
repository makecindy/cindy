import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import type { ProviderGroupMember } from '../../../shared/providerGroup';
import {
  createProviderGroupUsageReader, providerGroupUsageSnapshot, providerGroupUsageState,
  providerGroupCodexUsageSnapshot, providerGroupMemberUsageState,
  providerGroupCodexUsageFromReads, providerGroupRebalanceTarget,
  PROVIDER_GROUP_USAGE_MAX_AGE_MS, PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS,
} from '../usage';

const NOW = 1_000_000;
const DAY = 86_400_000;
const snapshot = (fiveHour = 20, sevenDay = 40): ClaudeSubscriptionUsageSnapshot => ({
  updatedAt: NOW,
  fiveHour: { utilization: fiveHour, resetsAt: (NOW + 3_600_000) / 1000 },
  sevenDay: { utilization: sevenDay, resetsAt: (NOW + DAY) / 1000 },
});
// A weekly window resetting in one day has 1/7 of its time left: urgency = (100 - used) × 0.07.
const urgencyOneDayLeft = (used: number) => expect.closeTo((100 - used) * 0.07);

// Unit: group routing must not let a different model/harness bucket block or refresh this model's quota.
// Existing Claude cases do not cover Codex's per-bucket timestamps, WHAM slot or variable window durations.
describe('OpenAI group quota snapshots', () => {
  const bucket = (usedPercent: number, minutes = 300, resetsAt = 3_000) => ({
    updatedAt: NOW, primary: { usedPercent, windowMinutes: minutes, resetsAt },
    secondary: { usedPercent: 20, windowMinutes: 10_080, resetsAt: (NOW + DAY) / 1000 },
  });
  const state = (raw: unknown, model = 'gpt-5.3-codex', agentKind = 'codex') =>
    providerGroupMemberUsageState({ codexUsage: providerGroupCodexUsageSnapshot(raw) }, model, NOW, agentKind);

  it('uses only the selected model bucket, and only WHAM for bridge/Pi', () => {
    const raw = { appServerBuckets: {
      codex: bucket(20), spark: { ...bucket(100), limitName: 'GPT-5.3-Codex-Spark' },
    }, webSnapshot: bucket(100) };
    expect(state(raw)).toMatchObject({ limited: false, urgency: urgencyOneDayLeft(20) });
    expect(state(raw, 'gpt-5.3-codex-spark')).toMatchObject({ limited: true, resetAtMs: 3_000_000 });
    expect(state(raw, 'gpt-5.3-codex', 'pi').limited).toBe(true);
    expect(state(raw, 'chatgpt/gpt-5.3-codex', 'claude-code').limited).toBe(true);
    expect(state({ appServerBuckets: raw.appServerBuckets }, 'gpt-5.3-codex', 'pi'))
      .toMatchObject({ limited: false, urgency: null });
    expect(state({ appServerBuckets: { spark: raw.appServerBuckets.spark } }))
      .toMatchObject({ limited: false, urgency: null });
  });

  it.each([NOW - PROVIDER_GROUP_USAGE_MAX_AGE_MS - 1, NOW + 60_001, null])(
    'does not refresh a stale/undated model bucket from another bucket (%s)', (updatedAt) => {
      const raw = { appServerBuckets: { codex: bucket(5), spark: { ...bucket(100), updatedAt, limitName: 'GPT-5.3-Codex-Spark' } } };
      expect(state(raw, 'gpt-5.3-codex-spark')).toMatchObject({ limited: false, urgency: null });
    },
  );

  it('ranks by the weekly window, does not invent quota for expired/malformed ones, and supports single-window plans', () => {
    const weekly = (secondary: unknown) => state({ ...bucket(20), secondary });
    expect(weekly({ usedPercent: 100, windowMinutes: 10_080, resetsAt: NOW / 1000 }))
      .toMatchObject({ limited: false, urgency: null });
    expect(weekly({ usedPercent: '0', windowMinutes: 10_080, resetsAt: (NOW + DAY) / 1000 }))
      .toMatchObject({ limited: false, urgency: null });
    expect(state({ ...bucket(100), primary: { usedPercent: 100 } }))
      .toMatchObject({ limited: true, resetAtMs: null });
    // A busy 5-hour window short of exhaustion does not change urgency; it is tight only when its reset is over an hour away.
    expect(state(bucket(90))).toMatchObject({ limited: false, fiveHourTight: false, urgency: urgencyOneDayLeft(20) });
    expect(state(bucket(90, 300, (NOW + 3 * 3_600_000) / 1000)).fiveHourTight).toBe(true);
    expect(state({ ...bucket(100), primary: null })).toMatchObject({ limited: false, urgency: urgencyOneDayLeft(20) });
    // 5-hour-only plan: 20% used, 2,000 s of 18,000 s left → 80 / 11.1 = 7.2.
    expect(weekly(null)).toMatchObject({ limited: false, urgency: expect.closeTo(7.2) });
  });

  it('preserves legacy single-bucket/web snapshots while dropping identity and credit offers', () => {
    const raw = { ...bucket(35), accountId: 'private', resetOffer: { idempotencyKey: 'private' } };
    const parsed = providerGroupCodexUsageSnapshot(raw);
    expect(state(parsed)).toMatchObject({ limited: false, urgency: urgencyOneDayLeft(20) });
    expect(JSON.stringify(parsed)).not.toContain('private');
    const web = { ...bucket(65), secondary: { usedPercent: 50, windowMinutes: 10_080, resetsAt: (NOW + DAY) / 1000 } };
    expect(state({ ...web, source: 'openai-web' }, 'gpt-5', 'pi').urgency).toEqual(urgencyOneDayLeft(50));
  });

  it('uses freshly read native quotas without depending on an open task or refreshing stale WHAM data', () => {
    const stale = { ...bucket(100), updatedAt: NOW - PROVIDER_GROUP_USAGE_MAX_AGE_MS - 1 };
    const fresh = providerGroupCodexUsageFromReads({ appServerBuckets: { codex: stale }, webSnapshot: stale }, {
      rateLimits: { primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 3_000 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 3_000 } } },
    }, NOW);
    expect(state(fresh)).toMatchObject({ limited: false, urgency: expect.closeTo(6.75) });
    expect(state(fresh, 'gpt-5.3-codex', 'pi')).toMatchObject({ limited: false, urgency: null });
    expect(state(providerGroupCodexUsageFromReads(bucket(40), null, NOW)).urgency).toEqual(urgencyOneDayLeft(20));
  });
});
const member = (kind: ProviderGroupMember['kind'], agentDeviceId: string | null, providerId = 'anthropic'): ProviderGroupMember => ({
  key: `${kind}:${agentDeviceId}:${providerId}`, kind, agentDeviceId, providerId, paused: false, limit: 4, weight: 1,
});
const REMOTE = member('device', 'mini');

afterEach(() => vi.useRealTimers());

describe('provider group quota eligibility', () => {
  it.each([[100, 10], [10, 100]])('excludes exhausted windows before comparing usage (%s, %s)', (fiveHour, sevenDay) => {
    expect(providerGroupUsageState(snapshot(fiveHour, sevenDay), 'opus', NOW).limited).toBe(true);
  });

  it('ranks by the total and the selected model’s weekly window, whichever is less urgent', () => {
    const value = { ...snapshot(), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 3_000 }] };
    expect(providerGroupUsageState(value, 'claude-opus-5-5', NOW).limited).toBe(true);
    expect(providerGroupUsageState(value, 'claude-sonnet-5', NOW)).toMatchObject({ limited: false, urgency: urgencyOneDayLeft(40) });
    expect(providerGroupUsageState(value, null, NOW).limited).toBe(false);
    const fastOpus = { ...snapshot(), scoped: [{ modelDisplayName: 'Opus', utilization: 90, resetsAt: (NOW + DAY) / 1000 }] };
    expect(providerGroupUsageState(fastOpus, 'claude-opus-5-5', NOW).urgency).toEqual(urgencyOneDayLeft(90));
    // The 5-hour window never changes urgency; it only excludes or marks the account (see the next tests).
    expect(providerGroupUsageState(snapshot(85, 20), 'opus', NOW).urgency).toEqual(urgencyOneDayLeft(20));
    expect(providerGroupUsageState({ ...snapshot(), fiveHour: null }, 'opus', NOW).urgency).toEqual(urgencyOneDayLeft(40));
  });

  // 2026-10-21 用户裁决(provider-groups.md §5)：快作废的额度最优先，其次各账号平均。
  // Minimal inputs: weekly usage × time left, including an expiring window with little left that must still
  // outrank a mid-week account that is further behind (a plain "behind schedule" score would not).
  it.each([
    ['half the week left, 60% used', 60, 3.5 * DAY, 0.8],
    ['one day left, 60% used', 60, DAY, 2.8],
    ['half the week left, 20% used', 20, 3.5 * DAY, 1.6],
    ['three hours left, 97% used', 97, 3 * 3_600_000, 1.68],
    ['not started yet', 0, null, 1],
    ['used without a reset time', 10, null, null],
  ] as const)('rates urgency as quota left ÷ time left: %s', (_name, used, resetInMs, urgency) => {
    const value = { updatedAt: NOW, fiveHour: null,
      sevenDay: { utilization: used, resetsAt: resetInMs === null ? null : (NOW + resetInMs) / 1000 } };
    expect(providerGroupUsageState(value, 'opus', NOW).urgency).toEqual(urgency === null ? null : expect.closeTo(urgency));
  });

  // 2026-10-21 用户裁决：5 小时配额快满(85%+)、离重置还早的先不分新任务；1 小时内就重置的照常分，把剩下的用掉。
  it.each([
    ['nearly full, resets in 3 hours', 90, 3 * 3_600_000, true],
    ['nearly full, resets in 30 minutes', 90, 30 * 60_000, false],
    ['nearly full, reset unknown', 90, null, true],
    ['already reset, awaiting a new snapshot', 90, 0, false],
    ['below the line', 80, 3 * 3_600_000, false],
  ] as const)('marks a tight 5-hour window: %s', (_name, used, resetInMs, tight) => {
    const value = { ...snapshot(), fiveHour: { utilization: used, resetsAt: resetInMs === null ? null : (NOW + resetInMs) / 1000 } };
    expect(providerGroupUsageState(value, 'opus', NOW).fiveHourTight).toBe(tight);
  });

  // 2026-10-21 用户裁决(provider-groups.md §6.2)：任务进行中换号会丢一部分上下文，只在明显更该先用另一个账号时提议，
  // 与新任务排序同一把尺子。Minimal inputs: the 15-point gain line for the same reset, an expiring window, and unknown data.
  const week = (usedPercent: number, resetInMs: number | null) =>
    ({ usedPercent, resetAtMs: resetInMs === null ? null : NOW + resetInMs, windowMs: 7 * DAY });
  it.each([
    ['same reset, 70% vs 50% used', week(70, DAY), week(50, DAY), 'other'],
    ['same reset, 60% vs 50% used: too small to be worth it', week(60, DAY), week(50, DAY), null],
    ['the other expires sooner with as much left', week(40, 3.5 * DAY), week(40, DAY), 'other'],
    ['this one expires sooner', week(20, DAY), week(0, 3.5 * DAY), null],
    ['this one has no reset time to compare', week(10, null), week(0, DAY), null],
  ])('offers switching a running task only when clearly worth it: %s', (_name, current, other, expected) => {
    expect(providerGroupRebalanceTarget(current, [{ key: 'other', quota: other }], NOW)).toBe(expected);
  });

  it('waits for the last exhausted window and never borrows another window’s reset', () => {
    expect(providerGroupUsageState(snapshot(100, 100), 'opus', NOW).resetAtMs).toBe(NOW + 86_400_000);
    const unknownReset = { ...snapshot(100, 100), fiveHour: { utilization: 100 } };
    expect(providerGroupUsageState(unknownReset, 'opus', NOW)).toMatchObject({ limited: true, resetAtMs: null });
  });

  it('does not keep blocking a reset window or rank it as unused before fresh data arrives', () => {
    const value = { ...snapshot(20, 100), sevenDay: { utilization: 100, resetsAt: NOW / 1000 } };
    expect(providerGroupUsageState(value, 'opus', NOW))
      .toEqual({ limited: false, resetAtMs: null, fiveHourTight: false, urgency: null, quota: null });
  });

  it('keeps unknown and stale data distinct from low usage', () => {
    for (const raw of [null, {}, { ...snapshot(), updatedAt: null }, { ...snapshot(), updatedAt: NOW + 120_000 },
      { ...snapshot(), sevenDay: null }, { ...snapshot(), sevenDay: { utilization: '0' } }]) {
      expect(providerGroupUsageState(raw, 'opus', NOW)).toMatchObject({ limited: false, urgency: null });
    }
    expect(providerGroupUsageState(snapshot(100, 100), 'opus', NOW + PROVIDER_GROUP_USAGE_MAX_AGE_MS + 1))
      .toMatchObject({ limited: false, urgency: null });
    expect(providerGroupUsageState({ ...snapshot(), sevenDay: null, fiveHour: { utilization: 100 } }, 'opus', NOW).limited).toBe(true);
  });

  it('reuses the rejected-window check and sanitizes remote data without exposing account identity', () => {
    const value = { ...snapshot(), rateLimitStatus: 'rejected', representativeClaim: 'five_hour',
      accountFingerprint: 'private-account', scoped: [null, { modelDisplayName: 8, utilization: 100 }] };
    expect(providerGroupUsageState(value, 'opus', NOW).limited).toBe(true);
    expect(providerGroupUsageSnapshot(value, NOW)).not.toHaveProperty('accountFingerprint');
    expect(providerGroupUsageSnapshot(value, NOW)?.scoped).toEqual([]);
  });
});

describe('provider group usage reads', () => {
  function harness() {
    let now = NOW;
    let current = true;
    const readLocal = vi.fn(async (_providerId: string) => snapshot());
    const readRemote = vi.fn(async (_device: string, _providerId: string) => snapshot());
    const reader = createProviderGroupUsageReader({ readLocal, readRemote, parseSnapshot: providerGroupUsageSnapshot, now: () => now, isCurrent: () => current });
    return { reader, readLocal, readRemote, advance: (ms: number) => { now += ms; }, leave: () => { current = false; } };
  }

  it('reads the correct device and provider, coalesces remote reads, and refreshes local snapshots', async () => {
    const h = harness();
    await Promise.all([h.reader.read(REMOTE), h.reader.read(REMOTE)]);
    expect(h.readRemote).toHaveBeenCalledExactlyOnceWith('mini', 'anthropic');
    await h.reader.read(REMOTE);
    expect(h.readRemote).toHaveBeenCalledTimes(1);
    await h.reader.read(member('device', 'mini', 'anthropic-second'));
    expect(h.readRemote).toHaveBeenLastCalledWith('mini', 'anthropic-second');
    await h.reader.read(member('local', null));
    await h.reader.read(member('local', null));
    expect(h.readLocal).toHaveBeenCalledTimes(2);
    h.advance(15_001);
    await h.reader.read(REMOTE);
    expect(h.readRemote).toHaveBeenCalledTimes(3);
    h.reader.invalidate();
    await h.reader.read(REMOTE);
    expect(h.readRemote).toHaveBeenCalledTimes(4);
  });

  it('never requests another person’s subscription quota', async () => {
    const h = harness();
    expect(await h.reader.read(member('share', 'share:s1'))).toBeNull();
    expect(await h.reader.read(member('device', 'share:s1'))).toBeNull();
    expect(h.readLocal).not.toHaveBeenCalled();
    expect(h.readRemote).not.toHaveBeenCalled();
  });

  it('falls back on unsupported peers or failed reads without caching an invented zero', async () => {
    const h = harness();
    h.readRemote.mockRejectedValue(new Error('CHANNEL_NOT_ALLOWED'));
    expect(await h.reader.read(REMOTE)).toBeNull();
    expect(await h.reader.read(REMOTE)).toBeNull();
    expect(h.readRemote).toHaveBeenCalledTimes(1);
  });

  it('bounds a slow read, keeps one request in flight and uses its eventual result', async () => {
    vi.useFakeTimers();
    const h = harness();
    let complete!: (value: ClaudeSubscriptionUsageSnapshot) => void;
    h.readRemote.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const first = h.reader.read(REMOTE);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    expect(await first).toBeNull();
    const second = h.reader.read(REMOTE);
    await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_USAGE_READ_TIMEOUT_MS);
    expect(await second).toBeNull();
    expect(h.readRemote).toHaveBeenCalledTimes(1);
    complete(snapshot(35, 45));
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.reader.read(REMOTE)).toMatchObject({ fiveHour: { utilization: 35 } });
  });

  it('drops an in-flight snapshot when the Cindy account changes', async () => {
    const h = harness();
    h.readRemote.mockImplementation(async () => { h.leave(); return snapshot(); });
    expect(await h.reader.read(REMOTE)).toBeNull();
    expect(await h.reader.read(member('local', null))).toBeNull();
    expect(h.readLocal).not.toHaveBeenCalled();
  });
});
