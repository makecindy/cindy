/**
 * 手机在被控电脑上用那台的模型组(Desktop docs/product-rules/model-groups.md §6.3)。
 *
 * 测试价值
 * - 生产入口与可观察结果：transport 的 listModelGroups / resolveModelGroup(经 device-link invoke)、
 *   parseHostModelGroupResult、applyHostModelGroupRoute + buildRemoteCreateSessionOptions 发出的创建参数、
 *   applyHostModelGroupResult 请那台做的记录与说明。
 * - 规则依据：model-groups.md §6.3(由那台电脑选、选出的模型只用于这次新建、那台是旧版本时不显示)；
 *   协议记录 docs/dev-rules/protocol-compatibility/model-groups-remote-pickers.md。
 * - 现有覆盖缺口：手机此前只在伙伴设置里认识模型组，新任务与进行中任务没有这条路径。
 * - 最小失败输入：旧电脑回 CHANNEL_NOT_ALLOWED 时报错而不是不显示，或之后升级了也一直不再问；
 *   换账号后仍显示上一账号的模式，或旧账号读取的迟到结果写进新账号；那台送来坏结果被当成选中；
 *   选出的来源没写进创建参数，或沿用了草稿的 Fast / 另一台电脑的位置；沿用原模型时仍去记绑定。
 * - 2026-11-21 新增的选法：那台电脑把真实选法放在 pick、旧版认识的放在 strategy；这里读 pick。认不出的选法
 *   只是不写标签，模式照样列出(此前整条丢掉，旧手机上就选不到这个模式)。
 * - tier：unit(纯函数与注入 invoke 的 transport，无原生依赖)。
 */
import { describe, expect, it, vi } from 'vitest';

import { __testing as authOwnerTesting, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import {
  applyHostModelGroupResult,
  applyHostModelGroupRoute,
  buildHostModelGroupRouteNote,
  cachedHostModelGroups,
  cachedHostModelGroupsPayload,
  parseHostModelGroupResult,
  parseHostModelGroupSessionBinding,
  parseHostModelGroupSwitchOffer,
  readHostModelGroups,
  resetHostModelGroupsCacheForTests,
} from '@/session/hostModelGroups';
import {
  implicitMobileSourceRouteSelection,
  isMobileSourceRouteProviderId,
  withMobileSourceRouteProviders,
} from '@/session/sourceRouteProviders';
import { parseCompanionModelGroups } from '@/session/companionProfileData';
import { buildRemoteCreateSessionOptions, type NewSessionDraft } from '@/session/newSession';

const draft: NewSessionDraft = {
  agentKind: 'claude-code', workspaceKind: 'project', workingDir: '/repo', model: 'claude-fable-5',
  providerId: 'xd', effort: 'high', permissionMode: 'default', fastMode: true, firstMessage: 'hi',
  agentDeviceId: 'mac-mini',
};

const routed = {
  outcome: 'routed', groupName: 'Daily', decisionId: 'd1', modelName: 'GPT', sourceName: 'Work',
  route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6', effort: 'medium' },
  why: 'expiring', quota: { usedPercent: 40, resetAtMs: 1_000 }, trace: [{ state: 'picked', limitedUntilMs: null }],
};

describe('the host computer\'s model groups over device-link', () => {
  it('treats an older computer without the channel as having no model groups', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] model-groups:get'), { code: 'CHANNEL_NOT_ALLOWED' });
    }) as unknown as RemoteInvoke;
    await expect(createMobileMakerTransport({ deviceId: 'old-desk', invoke }).listModelGroups()).resolves.toBeNull();
  });

  it('asks an older computer again after a while, so an upgrade shows its modes without reopening the app', async () => {
    vi.useFakeTimers();
    resetHostModelGroupsCacheForTests();
    setMobileAuthOwner('account-a');
    try {
      const listModelGroups = vi.fn().mockResolvedValueOnce(null)
        .mockResolvedValue({ routes: [{ id: 'daily', name: 'Daily', strategy: 'order', candidates: [] }] });
      await readHostModelGroups('desk', { listModelGroups });
      await readHostModelGroups('desk', { listModelGroups });
      expect(listModelGroups).toHaveBeenCalledTimes(1);
      expect(cachedHostModelGroups('desk')).toBeNull();
      vi.advanceTimersByTime(5 * 60_000);
      await readHostModelGroups('desk', { listModelGroups });
      expect(cachedHostModelGroups('desk')?.map((group) => group.id)).toEqual(['daily']);
    } finally {
      vi.useRealTimers();
      resetHostModelGroupsCacheForTests();
      authOwnerTesting.reset();
    }
  });

  it('keeps each account\'s modes apart and drops a late answer from the previous account', async () => {
    resetHostModelGroupsCacheForTests();
    const daily = { routes: [{ id: 'daily', name: 'Daily', strategy: 'order', candidates: [] }] };
    try {
      setMobileAuthOwner('account-a');
      await readHostModelGroups('desk', { listModelGroups: vi.fn().mockResolvedValue(daily) });
      expect(cachedHostModelGroups('desk')?.map((group) => group.id)).toEqual(['daily']);
      // Switching accounts hides A's answer at once.
      setMobileAuthOwner('account-b');
      expect(cachedHostModelGroups('desk')).toBeNull();

      // A read started under B finishes after switching back to A: B's answer is not shown to A.
      let finishLate!: (value: unknown) => void;
      const late = readHostModelGroups('desk', { listModelGroups: () => new Promise((resolve) => { finishLate = resolve; }) });
      setMobileAuthOwner('account-a');
      const listA = vi.fn().mockResolvedValue({ routes: [] });
      await readHostModelGroups('desk', { listModelGroups: listA });
      finishLate(daily);
      await late;
      expect(listA).toHaveBeenCalledTimes(1);
      expect(cachedHostModelGroups('desk')).toEqual([]);
    } finally {
      resetHostModelGroupsCacheForTests();
      authOwnerTesting.reset();
    }
  });

  it('asks the host to pick and builds the new task from its pick, without Fast or the old location', async () => {
    const invoke = vi.fn(async () => routed) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: 'desk', invoke });
    const result = parseHostModelGroupResult(await maker.resolveModelGroup({ selection: { type: 'route', id: 'daily' }, context: { hasImages: true } }));
    expect(invoke).toHaveBeenCalledWith('desk', 'model-groups:resolve', [{ selection: { type: 'route', id: 'daily' }, context: { hasImages: true } }]);
    const opts = buildRemoteCreateSessionOptions(applyHostModelGroupRoute(draft, result));
    expect(opts).toMatchObject({ agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6', effort: 'medium', fastMode: false });
    expect(opts).not.toHaveProperty('agentDeviceId');
  });

  it.each([
    { name: 'unknown outcome', raw: { outcome: 'picked' } },
    { name: 'routed without a usable route', raw: { ...routed, route: { agentKind: 'acp', providerId: 'x', model: 'y' } } },
    { name: 'not an object', raw: 'routed' },
  ])('rejects a malformed host answer: $name', ({ raw }) => {
    expect(parseHostModelGroupResult(raw)).toBeNull();
  });

  it('keeps the draft when the host has no usable source, and only commits the decision', () => {
    const unavailable = parseHostModelGroupResult({ outcome: 'unavailable', groupName: 'Daily', decisionId: 'd2', trace: [] });
    expect(applyHostModelGroupRoute(draft, unavailable)).toBe(draft);
    const maker = {
      commitModelGroupDecision: vi.fn(async () => undefined),
      bindModelGroupSession: vi.fn(async () => undefined),
      writeModelGroupRouteNote: vi.fn(async () => undefined),
    };
    applyHostModelGroupResult(maker, 's1', 'daily', unavailable, { pluginName: 'Daily', outcome: 'kept' });
    expect(maker.commitModelGroupDecision).toHaveBeenCalledWith('d2');
    expect(maker.bindModelGroupSession).not.toHaveBeenCalled();
    expect(maker.writeModelGroupRouteNote).toHaveBeenCalledWith({ sessionId: 's1', note: { pluginName: 'Daily', outcome: 'kept' } });
  });

  it('records which source the task uses when the host picked one', () => {
    const maker = {
      commitModelGroupDecision: vi.fn(async () => undefined),
      bindModelGroupSession: vi.fn(async () => undefined),
      writeModelGroupRouteNote: vi.fn(async () => undefined),
    };
    applyHostModelGroupResult(maker, 's1', 'daily', parseHostModelGroupResult(routed), null);
    expect(maker.bindModelGroupSession).toHaveBeenCalledWith({
      sessionId: 's1', selection: { type: 'route', id: 'daily' },
      route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6' },
    });
    expect(maker.writeModelGroupRouteNote).not.toHaveBeenCalled();
  });
});

describe('host model group strategies', () => {
  it('reads the real strategy and keeps modes whose strategy this app does not know', () => {
    const groups = parseCompanionModelGroups({ routes: [
      { id: 'w', name: 'Weighted', strategy: 'rotate', pick: 'weighted', candidates: [] },
      { id: 'n', name: 'Newer', strategy: 'someday', candidates: [] },
      { id: 'o', name: 'Old host', strategy: 'order', candidates: [] },
    ] });
    expect(groups?.map((group) => [group.id, group.strategy])).toEqual([['w', 'weighted'], ['n', undefined], ['o', 'order']]);
  });

  it('explains the new strategies in the route note', () => {
    const routed = (why: string, usedPercent?: number) => parseHostModelGroupResult({
      outcome: 'routed', groupName: 'G', route: { agentKind: 'codex', providerId: 'a', model: 'gpt' },
      modelName: 'GPT', sourceName: 'A', why, quota: usedPercent === undefined ? null : { usedPercent, resetAtMs: null }, trace: [],
    });
    // 翻译函数原样回 key 与参数，看说明里写的是哪一句。
    const t = ((key: string, values?: Record<string, unknown>) => (values?.left !== undefined ? `${key}:${values.left}` : key)) as never;
    const reason = (why: string, usedPercent?: number) => buildHostModelGroupRouteNote(routed(why, usedPercent), 'Kept', t, 'en', () => '')?.reason;
    expect(reason('headroom', 26)).toBe('models.modelGroups.why.headroomQuota:74');
    expect(reason('headroom')).toBe('models.modelGroups.why.headroom');
    expect(reason('drainNext')).toBe('models.modelGroups.why.drainNext');
    expect(reason('weighted')).toBe('models.modelGroups.why.weighted');
    // Newer hosts send an older stand-in in `why` and the real reason in `pickWhy`.
    const fromNewHost = parseHostModelGroupResult({
      outcome: 'routed', groupName: 'G', route: { agentKind: 'codex', providerId: 'a', model: 'gpt' },
      modelName: 'GPT', sourceName: 'A', why: 'order', pickWhy: 'drainNext', quota: null, trace: [],
    });
    expect(buildHostModelGroupRouteNote(fromNewHost, 'Kept', t, 'en', () => '')?.reason).toBe('models.modelGroups.why.drainNext');
  });

  it('preserves route fastMode, parses sourceRoutes + expandedRoutes, and parses binding / switchOffer', async () => {
    const fastRouted = parseHostModelGroupResult({
      ...routed,
      route: { ...routed.route, fastMode: 'ultrafast' },
    });
    expect(fastRouted?.outcome === 'routed' ? fastRouted.route.fastMode : null).toBe('ultrafast');
    expect(applyHostModelGroupRoute(draft, fastRouted).fastMode).toBe('ultrafast');

    resetHostModelGroupsCacheForTests();
    setMobileAuthOwner('account-sr');
    try {
      const invoke = vi.fn(async () => ({
        routes: [{ id: 'daily', name: 'Daily', strategy: 'order', candidates: [] }],
        sourceRoutes: [{ id: 'sr1', name: 'Claude Pool', sources: [{ providerId: 'p1' }, { providerId: 'p2', agentDeviceId: 'mac-2' }] }],
        expandedRoutes: [{
          id: 'sr1:claude-opus', name: 'Claude Opus', parent: { id: 'sr1', name: 'Claude Pool' },
          candidates: [
            { agentKind: 'cc', providerId: 'p1', model: 'claude-opus' },
            { agentKind: 'cc', providerId: 'p2', model: 'claude-opus', agentDeviceId: 'mac-2' },
          ],
        }],
      })) as unknown as RemoteInvoke;
      const maker = createMobileMakerTransport({ deviceId: 'desk', invoke });
      await readHostModelGroups('desk', maker);
      expect(invoke).toHaveBeenCalledWith('desk', 'model-groups:get', [{ includeSourceRoutes: true }]);
      const payload = cachedHostModelGroupsPayload('desk');
      expect(payload?.sourceRoutes).toHaveLength(1);
      expect(payload?.expandedRoutes).toHaveLength(1);
      const localProviders = [
        { id: 'p1', name: 'P1', agents: ['claude-code'], connected: true, models: { 'claude-code': [{ id: 'claude-opus', name: 'Opus', efforts: ['high'] }] }, routing: {} },
      ] as any;
      const remoteMap = new Map([
        ['mac-2', [{ id: 'p2', name: 'P2', agents: ['claude-code'], connected: true, models: { 'claude-code': [{ id: 'claude-opus', name: 'Opus', efforts: ['high'] }] }, routing: {} }] as any],
      ]);
      const merged = withMobileSourceRouteProviders(localProviders, payload, undefined, remoteMap);
      expect(merged.providers.map((p) => p.id)).toEqual(['sroute:sr1']);
      expect(isMobileSourceRouteProviderId('sroute:sr1')).toBe(true);
      expect(merged.hidesRemote('mac-2', 'p2')).toBe(true);
      expect(merged.hit('sroute:sr1', 'claude-opus')?.route.id).toBe('sr1:claude-opus');
      expect(implicitMobileSourceRouteSelection(payload, { providerId: 'p1', model: 'claude-opus' })).toEqual({ type: 'route', id: 'sr1:claude-opus' });
    } finally {
      resetHostModelGroupsCacheForTests();
      authOwnerTesting.reset();
    }

    expect(parseHostModelGroupSessionBinding({
      selection: { type: 'route', id: 'sr1:claude-opus' },
      routeName: 'Claude Pool',
      parentId: 'sr1',
      parentName: 'Claude Pool',
      isSourceRoute: true,
      autoSwitch: true,
    })).toMatchObject({ routeName: 'Claude Pool', isSourceRoute: true, autoSwitch: true });

    expect(parseHostModelGroupSwitchOffer({
      selection: { type: 'route', id: 'daily' },
      groupName: 'Daily',
      agentKind: 'codex',
      providerId: 'openai-2',
      model: 'gpt-6',
      agentDeviceId: 'share:s1',
      fastMode: true,
      modelName: 'GPT 6',
      sourceName: 'Shared',
      crossEngine: false,
      crossLocation: true,
    })).toMatchObject({ providerId: 'openai-2', agentDeviceId: 'share:s1', fastMode: true, crossLocation: true });
  });
});
