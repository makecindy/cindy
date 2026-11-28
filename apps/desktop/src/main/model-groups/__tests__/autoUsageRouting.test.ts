/**
 * 测试价值
 * - 生产入口与可观察结果：createAutoUsageProfileStore / buildAutoUsageProfile / pickModelGroupCandidate /
 *   createModelGroupResolver / modelGroupWhyText / modelGroupsConfigForRemote / modelGroupResolveResultForRemote。
 * - 规则依据：智能路由「自动（expiring）」融合本机近 14 天用量画像、余量分析、实时并发与按量付费兜底；
 *   严格本机内存封闭不跨设备下发；「试一下」与任务说明准确归因，避免备用项「才重置」语义矛盾。
 * - 现有覆盖缺口：pick.test.ts 只覆盖纯配额 urgency 排序，未覆盖无配额共享/远端源不被淘汰、本机用量偏好、
 *   按量付费兜底、实时并发分流、SWR/0ms 同步读画像、切账号隔离以及 standbyQuotaNeutral 修复。
 * - 最小失败输入：个人号剩 34% 还有 3.7 天重置 + 共享号读不到配额（平时高频使用）+ 按量 API Key；
 *   旧逻辑会淘汰共享号死用个人号，且备用项会错误提示早于胜出项的日期「才重置」。
 * - tier：unit，纯函数与注入依赖。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import {
  modelGroupCandidateKey,
  modelGroupResolveResultForRemote,
  modelGroupResolveResultFromRemote,
  modelGroupsConfigForRemote,
  normalizeModelGroupsConfig,
  type ModelGroupRoute,
  type ModelGroupTraceQuota,
  type ModelGroupsConfig,
} from '../../../shared/modelGroups.js';
import { modelGroupWhyText } from '../../../shared/modelGroupRouteNoteText.js';
import {
  buildAutoUsageProfile,
  createAutoUsageProfileStore,
  effectiveRemainingTimeFactor,
  type AutoUsageSample,
} from '../autoUsageProfile.js';
import { pickModelGroupCandidate, type ModelGroupCandidateFacts } from '../pick.js';
import { createModelGroupResolver } from '../resolver.js';
import { createModelGroupRuntime } from '../runtimeCore.js';

const NOW = Date.UTC(2026, 10, 28, 3, 40); // Sat Nov 28 2026 11:40 CST
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const week = (usedPercent: number, resetInHours: number): ModelGroupTraceQuota => ({
  usedPercent,
  resetAtMs: NOW + resetInHours * HOUR,
  windowMs: WEEK,
});

const autoRoute = (candidates: ModelGroupRoute['candidates']): ModelGroupRoute => ({
  id: 'src:auto:openai:gpt-6.2-astra',
  name: 'GPT-6.2-Astra',
  strategy: 'expiring',
  candidates,
});

const fact = (
  windows: ModelGroupTraceQuota[] | null,
  extra: Partial<ModelGroupCandidateFacts> = {},
): ModelGroupCandidateFacts => ({
  available: true,
  modelName: 'GPT-6.2-Astra',
  sourceName: 'OpenAI',
  windows,
  ...extra,
});

describe('autoUsageProfile', () => {
  it('aggregates 14-day recency-decayed usage with canonical model ids and strips raw counts from priorities', () => {
    const samples: AutoUsageSample[] = [
      { providerId: 'openai', model: 'byok-codex/gpt-6.2-astra', atMs: NOW - DAY, tokens: 120_000 },
      { providerId: 'openai', model: 'gpt-6.2-astra', atMs: NOW - 2 * DAY, tokens: 80_000 },
      { providerId: 'openai', model: 'gpt-5-mini', atMs: NOW - 10 * DAY, tokens: 5_000 },
      // 超过 14 天的样本忽略
      { providerId: 'openai', model: 'ancient-model', atMs: NOW - 20 * DAY, tokens: 999_999 },
    ];
    const profile = buildAutoUsageProfile(samples, NOW);
    expect(profile.modelPriorities['gpt-6.2-astra']).toBe(1);
    expect(profile.modelPriorities['gpt-5-mini']).toBeGreaterThan(0);
    expect(profile.modelPriorities['gpt-5-mini']).toBeLessThan(profile.modelPriorities['gpt-6.2-astra']);
    expect(profile.modelPriorities['ancient-model']).toBeUndefined();
    expect(profile.activeDays).toBe(3);
  });

  // Unit: the local configuration read starts before background warmup;
  // it must receive the ranking when the first history read completes.
  it('returns local model priorities from the first cold profile read', async () => {
    let loadSamples!: (samples: AutoUsageSample[]) => void;
    const usage = createAutoUsageProfileStore({
      scope: () => 'owner', now: () => NOW,
      readSamples: () => new Promise((resolve) => { loadSamples = resolve; }),
    });
    const runtime = createModelGroupRuntime({
      scope: () => 'owner',
      localViews: async () => [],
      localAgents: () => [],
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map(),
      runningSessions: () => [],
      usageProfile: (options) => options?.dryRun ? usage.readForPreview() : usage.peek(),
      readSession: async () => null,
      isShared: () => false,
      hasGoal: async () => false,
    });
    const first = runtime.autoModelPriorities();
    await Promise.resolve();
    loadSamples([{ providerId: 'openai', model: 'gpt-6', atMs: NOW - HOUR, tokens: 50_000 }]);
    await expect(first).resolves.toEqual({ 'gpt-6': 1 });
  });

  it('shortens effective remaining time when user is active on weekdays but not weekends', () => {
    // 连续 8 个工作日活跃，周末 0 活跃
    const samples: AutoUsageSample[] = [2, 3, 4, 5, 6, 9, 10, 11].map((daysAgo) => ({
      providerId: 'openai',
      model: 'gpt-6.2-astra',
      atMs: Date.UTC(2026, 10, 28, 6) - daysAgo * DAY,
      tokens: 50_000,
    }));
    const profile = buildAutoUsageProfile(samples, NOW);
    // 周六上午到周一凌晨(40h 几乎全是周末)：有效剩余时间系数应 < 1
    const factor = effectiveRemainingTimeFactor(profile, NOW, NOW + 40 * HOUR);
    expect(factor).toBeLessThan(0.9);
  });

  it('keeps peek() strictly 0ms synchronous and clears cached profile on owner scope switch', async () => {
    let scope = 'owner-a';
    let resolveRead!: (rows: AutoUsageSample[]) => void;
    const readSamples = vi.fn(() => new Promise<AutoUsageSample[]>((resolve) => { resolveRead = resolve; }));
    const store = createAutoUsageProfileStore({ scope: () => scope, readSamples, now: () => NOW });

    // 冷启动 peek() 立即同步返回 null，并在微任务里后台触发加载（不阻塞当前帧）
    expect(store.peek()).toBeNull();
    await Promise.resolve();
    expect(readSamples).toHaveBeenCalledTimes(1);

    resolveRead([{ providerId: 'openai', model: 'gpt-6.2-astra', atMs: NOW - HOUR, tokens: 50_000 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.peek()?.modelPriorities['gpt-6.2-astra']).toBe(1);
    store.recordPick({ providerId: 'openai', model: 'gpt-6.2-sol' });
    expect(store.peek()?.modelPriorities['gpt-6.2-sol']).toBeGreaterThan(0);

    // 切账号后立刻隔离清空，绝不串用上一个账号的用量画像
    scope = 'owner-b';
    expect(store.peek()).toBeNull();
  });
});

describe('pickModelGroupCandidate · smart Auto (expiring)', () => {
  const candidates: ModelGroupRoute['candidates'] = [
    { agentKind: 'codex', providerId: 'openai', model: 'gpt-6.2-astra' },
    { agentKind: 'codex', providerId: 'openai', model: 'gpt-6.2-astra', agentDeviceId: 'share:team1' },
    { agentKind: 'codex', providerId: 'openai-api', model: 'gpt-6.2-astra' },
  ];

  it('routes to unknown-quota shared source when personal subscription is tight and keeps PAYG in reserve', () => {
    // 个人号只剩 25% 但还有 5 天才重置(u=0.35)；共享号看不到额度；API Key 按量付费
    const picked = pickModelGroupCandidate(
      autoRoute(candidates),
      [fact([week(75, 5 * 24)]), fact(null), fact(null, { payAsYouGo: true })],
      { now: NOW },
    );
    expect(picked.index).toBe(1);
    expect(picked.trace[1]).toMatchObject({ state: 'picked', why: 'autoBalance' });
    expect(picked.trace[2]).toMatchObject({ state: 'standby', why: 'paygReserve' });
  });

  it('picks habitual source with why=usageHabit even when an untouched personal account has 95% left with 5 days to go', () => {
    const profile = buildAutoUsageProfile([
      { providerId: 'openai', agentDeviceId: 'share:team1', model: 'gpt-6.2-astra', atMs: NOW - HOUR, tokens: 80_000 },
      { providerId: 'openai', agentDeviceId: 'share:team1', model: 'gpt-6.2-astra', atMs: NOW - DAY, tokens: 90_000 },
      { providerId: 'openai', agentDeviceId: 'share:team1', model: 'gpt-6.2-astra', atMs: NOW - 2 * DAY, tokens: 70_000 },
    ], NOW);
    // 个人号刚重置不久(95% 剩 5 天，u=1.33 < 2.0)；平时一直用共享号
    const picked = pickModelGroupCandidate(
      autoRoute(candidates),
      [fact([week(5, 5 * 24)]), fact(null), fact(null, { payAsYouGo: true })],
      { now: NOW, usageProfile: profile },
    );
    expect(picked.index).toBe(1);
    expect(picked.trace[1]).toMatchObject({ state: 'picked', why: 'usageHabit' });
  });

  it('still rescues genuinely expiring personal quota (>= 2x pace) before it goes to waste', () => {
    const profile = buildAutoUsageProfile([
      { providerId: 'openai', agentDeviceId: 'share:team1', model: 'gpt-6.2-astra', atMs: NOW - HOUR, tokens: 120_000 },
      { providerId: 'openai', agentDeviceId: 'share:team1', model: 'gpt-6.2-astra', atMs: NOW - DAY, tokens: 120_000 },
    ], NOW);
    // 个人号还剩 60% 但 20 小时后就重置(u=5.04 >= 2.0) -> 优先消耗快作废的额度
    const picked = pickModelGroupCandidate(
      autoRoute(candidates),
      [fact([week(40, 20)]), fact(null), fact(null, { payAsYouGo: true })],
      { now: NOW, usageProfile: profile },
    );
    expect(picked.index).toBe(0);
    expect(picked.trace[0]).toMatchObject({ state: 'picked', why: 'expiring' });
  });

  it('spreads concurrent tasks to an idle source (why=lessBusy) when the top source is already running', () => {
    const picked = pickModelGroupCandidate(
      autoRoute(candidates.slice(0, 2)),
      [fact([week(15, 6 * 24)], { running: 2 }), fact(null, { running: 0 })],
      { now: NOW },
    );
    expect(picked.index).toBe(1);
    expect(picked.trace[1]).toMatchObject({ state: 'picked', why: 'lessBusy' });
  });

  it('falls back to pay-as-you-go API key with why=paygFallback only when all subscriptions/shares are unavailable or limited', () => {
    const picked = pickModelGroupCandidate(
      autoRoute(candidates),
      [fact([week(100, 12)]), fact(null, { available: false }), fact(null, { payAsYouGo: true })],
      { now: NOW },
    );
    expect(picked.index).toBe(2);
    expect(picked.trace[2]).toMatchObject({ state: 'picked', why: 'paygFallback' });
  });

  // 最小回归：三条同分来源，旧行为只在前两条之间轮转。
  it.each([{ windows: null }, { windows: [week(40, 20)] }])('soft-rotates through every matching source with quota $windows', ({ windows }) => {
    const three = [...candidates.slice(0, 2), { ...candidates[0], providerId: 'another-subscription' }];
    const route = autoRoute(three);
    const facts = three.map(() => fact(windows));
    let lastPickedKey: string | undefined;
    const order = [0, 1, 2, 0].map(() => {
      const picked = pickModelGroupCandidate(route, facts, { now: NOW, lastPickedKey });
      lastPickedKey = modelGroupCandidateKey(three[picked.index!]);
      return picked.index;
    });
    expect(order).toEqual([0, 1, 2, 0]);
  });
});

describe('modelGroupWhyText & remote privacy/protocol compatibility', () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join('|')}` : key;

  it('never says standbyQuota ("resets later") when standby resets earlier than picked or picked won via usageHabit', () => {
    const earlier = week(66, 88); // 34% left, Dec 2
    const later = week(90, 118); // 10% left, Dec 3
    // 1. 胜出项重置更晚 -> 备用项不能说 standbyQuota("才重置")，应走 standbyQuotaNeutral
    expect(modelGroupWhyText({ why: 'standby', quota: earlier }, t, 'en', { why: 'expiring', quota: later }))
      .toContain('modelGroups.why.standbyQuotaNeutral');
    // 2. 胜出项按 usageHabit 胜出 -> 备用项走 standbyQuotaNeutral
    expect(modelGroupWhyText({ why: 'standby', quota: later }, t, 'en', { why: 'usageHabit', quota: null }))
      .toContain('modelGroups.why.standbyQuotaNeutral');
    // 3. 只有胜出项按 expiring 胜出且备用项确实更晚重置时，才说 standbyQuota("才重置")
    expect(modelGroupWhyText({ why: 'standby', quota: later }, t, 'en', { why: 'expiring', quota: earlier }))
      .toContain('modelGroups.why.standbyQuota');
    // 4. 新原因文案
    expect(modelGroupWhyText({ why: 'usageHabit', quota: earlier }, t, 'en')).toBe('modelGroups.why.usageHabitQuota:34');
    expect(modelGroupWhyText({ why: 'usageHabit', quota: null }, t, 'en')).toBe('modelGroups.why.usageHabit');
    expect(modelGroupWhyText({ why: 'paygReserve', quota: null }, t, 'en')).toBe('modelGroups.why.paygReserve');
  });

  it('strips autoModelPriorities from persisted config and remote device-link payloads, and round-trips new why codes safely', () => {
    const localConfig: ModelGroupsConfig = {
      routes: [],
      autoModelPriorities: { 'gpt-6.2-astra': 1 },
    };
    expect(normalizeModelGroupsConfig(localConfig).autoModelPriorities).toBeUndefined();
    expect((modelGroupsConfigForRemote(localConfig, { includeSourceRoutes: true }) as unknown as Record<string, unknown>).autoModelPriorities).toBeUndefined();

    const remoteOut = modelGroupResolveResultForRemote({
      outcome: 'routed',
      groupName: 'OpenAI',
      route: { agentKind: 'codex', providerId: 'openai', model: 'gpt-6.2-astra' },
      modelName: 'GPT-6.2-Astra',
      sourceName: 'OpenAI',
      why: 'usageHabit',
      quota: null,
      trace: [{
        agentKind: 'codex', providerId: 'openai', model: 'gpt-6.2-astra',
        modelName: 'GPT-6.2-Astra', sourceName: 'OpenAI', state: 'picked', why: 'usageHabit', quota: null,
      }],
    });
    expect(remoteOut.outcome === 'routed' && remoteOut.why).toBe('expiring');
    const restored = modelGroupResolveResultFromRemote(remoteOut);
    expect(restored.outcome === 'routed' && restored.why).toBe('usageHabit');
  });

  it('resolver classifies api access as payAsYouGo and uses the local usage profile to choose a subscription', async () => {
    const view = (id: string, kind: 'subscription' | 'api') => ({
      id,
      name: id,
      source: 'user',
      connected: true,
      access: kind === 'subscription' ? { kind: 'subscription', product: 'Plus' } : { kind: 'api' },
      agents: ['codex'],
      routing: { codex: { enabled: true } },
      models: { codex: [{ id: 'gpt-6', name: 'GPT-6', mode: 'chat' }] },
    }) as unknown as ProviderView;
    const profile = buildAutoUsageProfile([
      { providerId: 'sub-b', model: 'gpt-6', atMs: NOW - HOUR, tokens: 90_000 },
      { providerId: 'sub-b', model: 'gpt-6', atMs: NOW - DAY, tokens: 90_000 },
      { providerId: 'sub-b', model: 'gpt-6', atMs: NOW - 2 * DAY, tokens: 90_000 },
    ], NOW);
    const onCommitPick = vi.fn();
    const resolver = createModelGroupResolver({
      config: () => ({
        routes: [{
          id: 'r-auto',
          name: 'GPT-6',
          strategy: 'expiring',
          candidates: [
            { agentKind: 'codex', providerId: 'sub-a', model: 'gpt-6' },
            { agentKind: 'codex', providerId: 'sub-b', model: 'gpt-6' },
            { agentKind: 'codex', providerId: 'api-key', model: 'gpt-6' },
          ],
        }],
      }),
      views: async () => [view('sub-a', 'subscription'), view('sub-b', 'subscription'), view('api-key', 'api')],
      agents: () => ['codex'],
      harnessInstalled: async () => true,
      quotaWindows: async () => new Map([['sub-a', [week(20, 5 * 24)]], ['sub-b', [week(25, 5 * 24)]]]),
      usageProfile: () => profile,
      onCommitPick,
      scope: () => 'owner',
      now: () => NOW,
    });
    const res = await resolver.resolve({ selection: { type: 'route', id: 'r-auto' } });
    expect(res).toMatchObject({ outcome: 'routed', route: { providerId: 'sub-b' }, why: 'usageHabit' });
    expect(res.trace[2]).toMatchObject({ state: 'standby', why: 'paygReserve' });
    expect(resolver.commit(res.decisionId!)).toBe(true);
    expect(onCommitPick).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'sub-b', model: 'gpt-6' }));
  });
});
