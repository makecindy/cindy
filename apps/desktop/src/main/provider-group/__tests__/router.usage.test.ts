/** Real directory → quota eligibility → scheduler → status projection, using only in-memory accounts. */
import type { ProviderView } from '@cindy/model-providers';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../shared/claudeSubscriptionUsage';
import { normalizeProviderGroupConfig, PROVIDER_GROUP_STRATEGIES, type ProviderGroupMember } from '../../../shared/providerGroup';
import { createProviderGroupDirectory } from '../directory';
import { createProviderGroupRouter } from '../router';
import { providerGroupCodexUsageSnapshot } from '../usage';

const NOW = 1_000_000;
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const view = (id: string): ProviderView => ({
  id, name: id, agents: ['claude-code'], connected: true, auth: { method: 'oauth', native: 'claude' },
  models: { 'claude-code': [OPUS, SONNET].map((id) => ({ id, name: id, efforts: [], defaultEffort: null })) },
  routing: { 'claude-code': {} },
}) as unknown as ProviderView;
const snapshot = (fiveHour: number, sevenDay: number): ClaudeSubscriptionUsageSnapshot => ({
  updatedAt: NOW, fiveHour: { utilization: fiveHour, resetsAt: 3_000 }, sevenDay: { utilization: sevenDay, resetsAt: 80_000 },
});

// Unit: directory → router → scheduler/status must apply OpenAI quotas to every group strategy.
// The existing matrix only exercises Claude snapshots; an OpenAI member used to ignore exhausted/lower/expiring quotas.
describe('OpenAI subscription group routing', () => {
  const GPT = 'gpt-5.3-codex';
  const SPARK = 'gpt-5.3-codex-spark';
  const quota = (fiveHour: number, weekly: number, weeklyReset = NOW + 3 * 86_400_000) => ({
    updatedAt: NOW, primary: { usedPercent: fiveHour, windowMinutes: 300, resetsAt: (NOW + 2 * 3_600_000) / 1000 },
    secondary: { usedPercent: weekly, windowMinutes: 10_080, resetsAt: weeklyReset / 1000 },
  });
  function openaiHarness() {
    const config = normalizeProviderGroupConfig({ strategy: 'order', members: [
      { kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'openai-second' },
    ] }, 'openai')!;
    const usage = new Map<string, unknown>();
    const provider = (id: string): ProviderView => ({
      id, name: 'OpenAI', agents: ['codex', 'pi'], connected: true, auth: { method: 'oauth', native: 'codex' },
      models: Object.fromEntries(['codex', 'pi'].map((agent) => [agent, [GPT, SPARK].map((id) => ({ id, name: id, efforts: [], defaultEffort: null }))])),
      routing: { codex: {}, pi: {} },
    }) as unknown as ProviderView;
    const readCodexUsage = vi.fn(async (member: ProviderGroupMember) => providerGroupCodexUsageSnapshot(usage.get(member.key)));
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [provider('openai')], localDeviceName: () => 'local',
      listDevices: async () => [{ deviceId: 'mini', name: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true,
        isSelf: false, platform: 'darwin', appVersion: null, lastSeenAt: null, busy: false }],
      readDeviceProviders: async () => [provider('openai-second')], listReceivedShares: () => [],
      isMobilePlatform: () => false, readCodexUsage, now: () => NOW,
    });
    const writeCooling = vi.fn();
    const router = createProviderGroupRouter({ directory, readGroup: () => config, listBindings: () => ({}),
      isTurnRunning: () => false, now: () => NOW, random: () => 0,
      coolingStore: { read: () => ({}), write: writeCooling } });
    const pick = (model = GPT, agentKind: 'codex' | 'pi' = 'codex') => router.pick({ providerId: 'openai', agentKind, model });
    return { config, usage, router, pick, writeCooling, remote: config.members[1].key };
  }

  it.each(PROVIDER_GROUP_STRATEGIES)('excludes exhausted windows and prefers the most urgent weekly quota (%s)', async (strategy) => {
    const h = openaiHarness();
    h.config.strategy = strategy;
    h.usage.set(h.remote, quota(40, 60));
    for (const [short, week] of [[100, 10], [10, 100]]) {
      h.usage.set('local', quota(short, week));
      expect(await h.pick()).toMatchObject({ member: { key: h.remote } });
      expect((await h.router.view('openai')).members[0]).toMatchObject({
        state: 'cooling', usageLimit: { resetAtMs: short === 100 ? NOW + 2 * 3_600_000 : NOW + 3 * 86_400_000 },
      });
    }
    h.usage.set('local', quota(10, 20));
    h.usage.set(h.remote, quota(40, 70, NOW + 3 * 3_600_000));
    expect(await h.pick()).toMatchObject({ member: { key: h.remote } });
    // With the same weekly reset, more quota left wins; a busy 5-hour window short of exhaustion does not count.
    h.usage.set('local', quota(80, 20));
    h.usage.set(h.remote, quota(20, 30));
    expect(await h.pick()).toMatchObject({ member: { key: 'local' } });
    expect(h.writeCooling).not.toHaveBeenCalled();
  });

  it('isolates model/harness quotas and keeps generic status independent of a dedicated model', async () => {
    const h = openaiHarness();
    h.usage.set('local', { appServerBuckets: {
      codex: quota(10, 20), spark: { ...quota(100, 10), limitName: SPARK },
    }, webSnapshot: quota(100, 20) });
    expect(await h.pick()).toMatchObject({ member: { key: 'local' } });
    expect(await h.pick(SPARK)).toMatchObject({ member: { key: h.remote } });
    expect(await h.pick(GPT, 'pi')).toMatchObject({ member: { key: h.remote } });
    expect((await h.router.view('openai')).members[0]).not.toHaveProperty('usageLimit');
    expect((await h.router.view('openai')).members[0].state).toBe('available');
    expect((await h.router.view('openai', SPARK)).members[0].state).toBe('cooling');
    expect((await h.router.view('openai', { model: GPT, agentKind: 'pi' })).members[0].state).toBe('cooling');
  });

  it('falls back to group order for unknown/stale quotas and reports unavailable only when both accounts are exhausted', async () => {
    const h = openaiHarness();
    h.usage.set('local', { ...quota(100, 100), updatedAt: NOW - 600_001 });
    expect(await h.pick()).toMatchObject({ member: { key: 'local' } });
    h.usage.set('local', quota(100, 20));
    h.usage.set(h.remote, quota(20, 100));
    expect(await h.pick()).toMatchObject({ kind: 'unavailable' });
    h.usage.set('local', { ...quota(100, 20), primary: { usedPercent: 100, resetsAt: NOW / 1000 } });
    expect(await h.pick()).toMatchObject({ member: { key: 'local' } });
  });
});

function harness() {
  let now = NOW;
  const config = normalizeProviderGroupConfig({
    strategy: 'usage', members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'mini', providerId: 'anthropic' }],
  }, 'anthropic')!;
  const usage = new Map<string, ClaudeSubscriptionUsageSnapshot | null>();
  const readUsage = vi.fn(async (member: ProviderGroupMember) => usage.get(member.key) ?? null);
  const directory = createProviderGroupDirectory({
    listLocalProviders: async () => [view('anthropic')], localDeviceName: () => 'local',
    listDevices: async () => [{ deviceId: 'mini', name: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true,
      isSelf: false, platform: 'darwin', appVersion: null, lastSeenAt: null, busy: false }],
    readDeviceProviders: async () => [view('anthropic')], listReceivedShares: () => [],
    isMobilePlatform: () => false, readClaudeUsage: readUsage, now: () => now,
  });
  const writeCooling = vi.fn();
  const router = createProviderGroupRouter({
    directory, readGroup: () => config, listBindings: () => ({}), isTurnRunning: () => false,
    coolingStore: { read: () => ({}), write: writeCooling }, now: () => now, random: () => 0,
  });
  const pick = (model = OPUS, reserveFor?: string) => router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model, reserveFor });
  return { config, usage, router, pick, writeCooling, readUsage, advance: (ms: number) => { now += ms; } };
}

describe('provider-group quota routing', () => {
  // Unit regression: an exhausted model plus a paused backup used to lose the quota reason
  // at pick(), preventing the task from showing/waiting for the actual reset.
  it('reports model quota exhaustion and the earliest usable reset without counting paused members', async () => {
    const h = harness();
    h.config.members[1].paused = true;
    h.usage.set('local', { ...snapshot(4, 66), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 80_000 }] });
    expect(await h.pick()).toMatchObject({ kind: 'unavailable', usageLimit: { resetAtMs: 80_000_000 } });
    expect(await h.pick(SONNET)).toMatchObject({ kind: 'member' });
    h.config.members[1].paused = false;
    h.usage.set(h.config.members[1].key, snapshot(100, 20));
    h.advance(15_001); // refresh the remote quota snapshot
    expect(await h.pick()).toMatchObject({ kind: 'unavailable', usageLimit: { resetAtMs: 3_000_000 } });
  });

  it('keeps unknown resets unknown and does not call a paused or unsupported pool quota-limited', async () => {
    const h = harness();
    h.config.members[1].paused = true;
    h.usage.set('local', { ...snapshot(4, 66), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: null }] });
    expect(await h.pick()).toMatchObject({ kind: 'unavailable', usageLimit: { resetAtMs: null } });
    expect(await h.pick('missing-model')).not.toHaveProperty('usageLimit');
    h.config.members[0].paused = true;
    expect(await h.pick()).not.toHaveProperty('usageLimit');
  });

  // PR #6611: pick() must not wake a task while its earliest quota-reset member is
  // still cooling. Unit gap: existing quota and cooldown cases never overlapped.
  it.each([undefined, OPUS])('waits for both quota reset and the existing cooldown (%s)', async (scope) => {
    const h = harness();
    const remote = h.config.members[1].key;
    h.usage.set('local', { ...snapshot(100, 20), fiveHour: { utilization: 100, resetsAt: (NOW + 300_000) / 1000 } });
    h.usage.set(remote, { ...snapshot(100, 20), fiveHour: { utilization: 100, resetsAt: (NOW + 600_000) / 1000 } });
    h.router.markCooling('anthropic', 'local', NOW + 1_800_000, scope);
    // The row describes the quota reset, even when a separate cooldown lasts longer.
    expect((await h.router.view('anthropic', OPUS)).members[0])
      .toMatchObject({ coolingUntil: NOW + 1_800_000, usageLimit: { resetAtMs: NOW + 300_000 } });
    expect(await h.pick()).toMatchObject({ kind: 'unavailable', usageLimit: { resetAtMs: NOW + 600_000 } });
    h.config.members[1].paused = true;
    expect(await h.pick()).toMatchObject({ kind: 'unavailable', usageLimit: { resetAtMs: NOW + 1_800_000 } });
    h.usage.set('local', { ...snapshot(100, 20), fiveHour: { utilization: 100, resetsAt: null } });
    expect(await h.pick()).toMatchObject({ kind: 'unavailable', usageLimit: { resetAtMs: null } });
  });

  it('isolates error cooldowns by model while total quota and account failures still block all models', async () => {
    const h = harness();
    h.config.strategy = 'order';
    const remote = h.config.members[1].key;
    h.router.markCooling('anthropic', 'local', NOW + 86_400_000, OPUS);
    expect(await h.pick(OPUS)).toMatchObject({ member: { key: remote } });
    expect(await h.pick(SONNET)).toMatchObject({ member: { key: 'local' } });
    expect((await h.router.view('anthropic')).members[0].state).toBe('available');
    expect((await h.router.view('anthropic', OPUS)).members[0].state).toBe('cooling');
    expect((await h.router.view('anthropic', OPUS)).members[0]).not.toHaveProperty('usageLimit');
    h.usage.set('local', snapshot(0, 100));
    expect(await h.pick(SONNET)).toMatchObject({ member: { key: remote } });
    expect((await h.router.view('anthropic')).members[0].state).toBe('cooling');
    h.usage.set('local', snapshot(0, 20));
    h.router.markCooling('anthropic', 'local', NOW + 60_000);
    expect(await h.pick(SONNET)).toMatchObject({ member: { key: remote } });
    h.advance(60_001);
    expect(await h.pick(SONNET)).toMatchObject({ member: { key: 'local' } });
    expect(await h.pick(OPUS)).toMatchObject({ member: { key: remote } });
  });
  it.each(PROVIDER_GROUP_STRATEGIES)('gives own tasks the same %s choice as incoming tasks, apart from the external pause', async (strategy) => {
    const remote = harness().config.members[1].key;
    const choose = async (localTask: boolean, paused: boolean, localUsage: [number, number]) => {
      const h = harness();
      h.config.strategy = strategy;
      h.config.members[0].paused = paused;
      h.usage.set('local', snapshot(...localUsage));
      h.usage.set(remote, snapshot(12, 22));
      const pick = await h.router.pick({
        providerId: 'anthropic', agentKind: 'claude-code', model: OPUS, ...(localTask ? { localTask: true as const } : {}),
      });
      return pick.kind === 'member' ? pick.member.key : pick.kind;
    };
    // Quota comes first for every strategy: a clearly lower-usage computer wins for everyone.
    expect(await choose(true, false, [85, 90])).toBe(remote);
    expect(await choose(false, false, [85, 90])).toBe(remote);
    // Similar usage leaves the choice to the strategy, which starts with this computer in group order.
    expect(await choose(true, false, [10, 20])).toBe('local');
    expect(await choose(false, false, [10, 20])).toBe('local');
    expect(await choose(true, true, [10, 20])).toBe('local');
    expect(await choose(false, true, [10, 20])).toBe(remote);
  });

  it('applies this computer’s concurrency limit to own tasks', async () => {
    const h = harness();
    h.config.strategy = 'order';
    h.config.members[0].limit = 1;
    const input = { providerId: 'anthropic', agentKind: 'claude-code' as const, model: OPUS, localTask: true as const };
    expect(await h.router.pick({ ...input, reserveFor: 's1' })).toMatchObject({ kind: 'member', member: { key: 'local' } });
    expect(await h.router.pick({ ...input, reserveFor: 's2' }))
      .toMatchObject({ kind: 'member', member: { key: h.config.members[1].key } });
  });

  // 2026-10-21 用户裁决(provider-groups.md §5)：快作废的额度最优先，其次各账号平均。Unit: real directory →
  // router → scheduler. The old fixed "last 5 hours" tier plus raw usage ignored a week with half left a day before
  // reset (case 1) and preferred a freshly reset account (case 3); case 2 guards against ranking by distance behind
  // schedule, which would leave the last 3% of an expiring week unused.
  it.each([false, true])('uses the quota that most needs using before it resets (own task=%s)', async (own) => {
    const h = harness();
    const remote = h.config.members[1].key;
    const HOUR = 3_600_000;
    const week = (utilization: number, inMs: number) => ({
      updatedAt: NOW, fiveHour: { utilization: 10, resetsAt: (NOW + HOUR) / 1000 }, sevenDay: { utilization, resetsAt: (NOW + inMs) / 1000 },
    });
    const pick = async () => {
      const result = await h.router.pick({
        providerId: 'anthropic', agentKind: 'claude-code', model: OPUS, ...(own ? { localTask: true as const } : {}),
      });
      return result.kind === 'member' ? result.member.key : result.kind;
    };
    // A week resetting tomorrow with 50% left beats a mid-week account with more left.
    h.usage.set('local', week(30, 84 * HOUR));
    h.usage.set(remote, week(50, 24 * HOUR));
    expect(await pick()).toBe(remote);
    // The last 3% of a week resetting in 3 hours still goes first, even though the other account is further behind.
    h.usage.set('local', week(40, 84 * HOUR));
    h.usage.set(remote, week(97, 3 * HOUR));
    expect(await pick()).toBe(remote);
    // A freshly reset week is not urgent.
    h.usage.set(remote, week(0, 168 * HOUR));
    expect(await pick()).toBe('local');
  });

  // 2026-10-21 用户裁决：5 小时配额快满、离重置还早的号先不分新任务(刚开始就撞上限会被迫换电脑、丢上下文)；
  // 1 小时内就重置的照常分，把剩下的用掉。Unit: real directory → router → scheduler. Minimal input: the more
  // urgent weekly account sits at 90% of its 5-hour window, resetting in 3 hours versus 30 minutes.
  it.each([[3 * 3_600_000, 'remote'], [30 * 60_000, 'local']] as const)(
    'avoids a nearly full 5-hour window unless it resets soon (resets in %i ms → %s)', async (fiveHourResetInMs, expected) => {
      const h = harness();
      const remote = h.config.members[1].key;
      const DAY = 86_400_000;
      h.usage.set('local', { updatedAt: NOW, fiveHour: { utilization: 90, resetsAt: (NOW + fiveHourResetInMs) / 1000 },
        sevenDay: { utilization: 50, resetsAt: (NOW + DAY) / 1000 } });
      h.usage.set(remote, { updatedAt: NOW, fiveHour: { utilization: 10, resetsAt: (NOW + 3_600_000) / 1000 },
        sevenDay: { utilization: 20, resetsAt: (NOW + 3.5 * DAY) / 1000 } });
      const result = await h.pick();
      expect(result.kind === 'member' ? result.member.key : result.kind).toBe(expected === 'remote' ? remote : 'local');
    },
  );

  // Unit / provider-groups.md §10 progress bar: the group status must carry the very window the ranking uses
  // (the less urgent of total and model weekly), and nothing for an account whose quota cannot be read.
  it('shows each account the weekly window it is ranked by, and nothing when unknown', async () => {
    const h = harness();
    const remote = h.config.members[1].key;
    const sevenDay = { utilization: 30, resetsAt: 80_000 };
    h.usage.set('local', { updatedAt: NOW, fiveHour: { utilization: 90, resetsAt: 3_000 }, sevenDay,
      scoped: [{ modelDisplayName: 'Opus', utilization: 95, resetsAt: 80_000 }] });
    const weekly = (usedPercent: number) => ({ usedPercent, resetAtMs: 80_000_000, windowMs: 7 * 86_400_000 });
    expect((await h.router.view('anthropic')).members.map((m) => m.quota)).toEqual([weekly(30), undefined]);
    expect((await h.router.view('anthropic', OPUS)).members[0].quota).toEqual(weekly(95));
    h.usage.set(remote, snapshot(10, 20));
    expect((await h.router.view('anthropic')).members[1].quota).toEqual(weekly(20));
  });

  it.each(PROVIDER_GROUP_STRATEGIES)('applies quota prefiltering to own tasks with the %s strategy', async (strategy) => {
    const context = harness();
    context.config.strategy = strategy;
    context.config.members[0].paused = true;
    const remote = context.config.members[1].key;
    context.usage.set(remote, snapshot(40, 60));
    const input = { providerId: 'anthropic', agentKind: 'claude-code' as const, model: OPUS, localTask: true as const };
    context.usage.set('local', snapshot(100, 5));
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: remote } });
    context.usage.set('local', snapshot(5, 100));
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: remote } });
    context.usage.set('local', { ...snapshot(10, 20), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 80_000 }] });
    expect(await context.router.pick(input)).toMatchObject({ kind: 'member', member: { key: remote } });
    expect(await context.router.pick({ ...input, model: SONNET })).toMatchObject({ kind: 'member', member: { key: 'local' } });
  });

  it.each(PROVIDER_GROUP_STRATEGIES)('excludes an exhausted account for the %s strategy', async (strategy) => {
    const h = harness();
    h.config.strategy = strategy;
    const remote = h.config.members[1].key;
    h.usage.set('local', snapshot(100, 5));
    h.usage.set(remote, snapshot(40, 60));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    expect((await h.router.view('anthropic')).members[0]).toMatchObject({
      state: 'cooling', coolingUntil: 3_000_000, usageLimit: { resetAtMs: 3_000_000 },
    });
    // Quota snapshots never overwrite error-derived cooldowns or turn a scoped limit into a persistent global one.
    expect(h.writeCooling).not.toHaveBeenCalled();
    h.usage.set('local', snapshot(5, 100));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    h.usage.set(remote, snapshot(100, 5));
    expect(await h.pick()).toMatchObject({ kind: 'unavailable' });
  });

  it('balances eligible accounts by usage, reserving simultaneous assignments immediately', async () => {
    const h = harness();
    const remote = h.config.members[1].key;
    h.usage.set('local', snapshot(20, 85));
    h.usage.set(remote, snapshot(55, 40));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    h.usage.set('local', snapshot(20, 40));
    h.usage.set(remote, snapshot(25, 43));
    const assignments = await Promise.all([h.pick(OPUS, 's1'), h.pick(OPUS, 's2')]);
    expect(assignments.map((p) => p.kind === 'member' ? p.member.key : p.kind)).toEqual(['local', remote]);
  });

  it('keeps model-specific limits out of the group-wide availability state', async () => {
    const h = harness();
    const remote = h.config.members[1].key;
    h.usage.set('local', { ...snapshot(10, 20), scoped: [{ modelDisplayName: 'Opus', utilization: 100, resetsAt: 80_000 }] });
    h.usage.set(remote, snapshot(40, 60));
    expect(await h.pick(OPUS)).toMatchObject({ kind: 'member', member: { key: remote } });
    expect(await h.pick(SONNET)).toMatchObject({ kind: 'member', member: { key: 'local' } });
    expect((await h.router.view('anthropic')).members[0].state).toBe('available');
    expect((await h.router.view('anthropic', OPUS)).members[0].state).toBe('cooling');
    expect((await h.router.view('anthropic', SONNET)).members[0].state).toBe('available');
    expect(h.router.coolingUntil('anthropic', 'local')).toBeNull();
  });

  it('does not promise an earlier recovery time when an exhausted window has no reset', async () => {
    const h = harness();
    h.usage.set('local', { ...snapshot(100, 20), fiveHour: { utilization: 100, resetsAt: null } });
    h.router.markCooling('anthropic', 'local', NOW + 60_000);
    const status = (await h.router.view('anthropic')).members[0];
    expect(status.state).toBe('cooling');
    expect(status.coolingUntil).toBeUndefined();
    expect(status.usageLimit).toEqual({ resetAtMs: null });
  });

  it('falls back for missing/failed data and releases old quota blocks after reset', async () => {
    const h = harness();
    h.usage.set('local', snapshot(100, 10));
    const remote = h.config.members[1].key;
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: remote } });
    h.advance(2_000_000);
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: 'local' } });
    h.readUsage.mockRejectedValue(new Error('unreachable'));
    expect(await h.pick()).toMatchObject({ kind: 'member', member: { key: 'local' } });
  });
});
