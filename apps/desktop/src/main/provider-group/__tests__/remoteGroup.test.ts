/**
 * 同账号另一台电脑上的供应商组(provider-groups.md §4「同账号直连」、§6)：
 * - 任务选了组所在电脑的这个供应商：问组所在电脑该用哪台，直接连过去，组员坐标换成本机的位置；
 * - 组员出问题时由本机换电脑，并把需要冷却的电脑报告给组所在电脑(连不上只自己避开)；
 * - 组所在电脑读不到时绑定不动，确认组没了才解除。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember, ProviderGroupView } from '../../../shared/providerGroup';
import type { ProviderGroupBinding, ProviderGroupRef } from '../bindings';
import type { ProviderGroupDirectory, ResolvedMemberState } from '../directory';
import { createProviderGroupRouter } from '../router';
import {
  createProviderGroupService,
  PROVIDER_GROUP_ADOPT_TIMEOUT_MS,
  PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS,
  PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS,
  PROVIDER_GROUP_UNAVAILABLE_ERROR,
  type ProviderGroupRemoteGroups,
  type ProviderGroupServiceDeps,
  type ProviderGroupSessionRow,
} from '../service';

const MODEL = 'claude-opus-5-5';
const OWNER = 'mac-mini';
const ME = 'my-laptop';

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null, providerId: string, label: string): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId, label, limit: 4, weight: 1, paused: false };
}

const OWNER_LOCAL = member('local', 'local', null, 'anthropic', 'Mac Mini');
const SELF = member(`device:${ME}:anthropic`, 'device', ME, 'anthropic', 'My Laptop');
const STUDIO = member('device:studio:anthropic-1a2b3c4d', 'device', 'studio', 'anthropic-1a2b3c4d', 'Studio');
const SHARED = member('share:s1:anthropic', 'share', 'share:s1', 'anthropic', 'Friend PC');

function harness(options: {
  row?: Partial<ProviderGroupSessionRow>;
  /** undefined = 组所在电脑读不到；null = 那台没有这个组。 */
  config?: ProviderGroupConfig | null | undefined;
  picks?: Array<ProviderGroupMember | 'unavailable' | 'none' | Error>;
  view?: Partial<Record<string, ProviderGroupView['members'][number]['state']>>;
  live?: boolean;
} = {}) {
  const config: ProviderGroupConfig | null | undefined = 'config' in options
    ? options.config
    : { strategy: 'least', autoSwitch: true, members: [OWNER_LOCAL, SELF, STUDIO, SHARED] };
  const picks = [...(options.picks ?? [STUDIO])];
  const bindings = new Map<string, ProviderGroupBinding>();
  /** 因组内电脑被移出或组被删除而解除过的任务 → 那个组。 */
  const released = new Map<string, ProviderGroupRef>();
  // 现读那台的状态(等它恢复时用)：默认一直连不上，单测按需逐次指定。
  const probe = vi.fn(async (_agentDeviceId: string, _providerId: string): Promise<ResolvedMemberState> => 'offline');
  const directory: ProviderGroupDirectory = {
    resolveMembers: async () => [],
    listCandidates: async () => [],
    readDeviceCatalog: async () => [],
    probe,
    memberLabel: (m) => m.label ?? m.key,
    invalidate: vi.fn(),
  };
  const router = createProviderGroupRouter({
    directory,
    readGroup: () => null,
    listBindings: () => ({}),
    isTurnRunning: () => false,
    now: () => 1_000,
    random: () => 0,
  });
  const remote = {
    readGroup: vi.fn(async () => config),
    pick: vi.fn(async () => {
      const next = picks.shift() ?? 'unavailable';
      if (next instanceof Error) throw next;
      if (next === 'unavailable' || next === 'none') return { kind: next };
      const { key, kind, agentDeviceId, providerId } = next;
      return { kind: 'member' as const, member: { key, kind, agentDeviceId, providerId }, label: next.label! };
    }),
    cool: vi.fn(async () => undefined),
    view: vi.fn(async (): Promise<ProviderGroupView> => ({
      providerId: 'anthropic',
      config: config ?? null,
      members: (config?.members ?? []).map((m) => ({
        key: m.key,
        kind: m.kind,
        label: m.label ?? m.key,
        state: options.view?.[m.key] ?? 'available',
        running: 0,
        limit: m.limit,
        weight: m.weight,
        paused: m.paused,
      })),
    })),
    invalidate: vi.fn(),
  } satisfies ProviderGroupRemoteGroups;
  const row: ProviderGroupSessionRow = {
    agentKind: 'claude-code',
    model: MODEL,
    providerId: 'anthropic',
    agentDeviceId: OWNER,
    remoteHostId: null,
    sdkSessionId: null,
    ...options.row,
  };
  const deps = {
    router,
    directory,
    readGroup: () => null,
    remote,
    localDeviceId: () => ME,
    readBinding: (id: string) => bindings.get(id) ?? null,
    writeBinding: vi.fn(async (id: string, binding: { providerId: string; memberKey: string; groupDeviceId?: string | null } | null) => {
      if (binding) bindings.set(id, { providerId: binding.providerId, memberKey: binding.memberKey, ...(binding.groupDeviceId ? { groupDeviceId: binding.groupDeviceId } : {}), at: 1 });
      else bindings.delete(id);
    }),
    isReleased: (id: string, group: ProviderGroupRef) => {
      const entry = released.get(id);
      return entry?.providerId === group.providerId && (entry.groupDeviceId ?? null) === (group.groupDeviceId ?? null);
    },
    markReleased: vi.fn(async (id: string, group: ProviderGroupRef) => {
      released.set(id, group);
    }),
    readSessionRow: vi.fn(async () => row),
    resolveImplicitProvider: vi.fn(async () => 'anthropic'),
    persistRoute: vi.fn(async (_id: string, route: { agentDeviceId: string | null; providerId: string | null }) => {
      row.agentDeviceId = route.agentDeviceId;
      row.providerId = route.providerId;
    }),
    hasAssistantHistory: vi.fn(async () => false),
    isFailoverEligible: vi.fn(async () => true),
    leaseRecovery: vi.fn((): object | null => ({})),
    isLeaseCurrent: vi.fn(() => true),
    rearmContinue: vi.fn((): number | null => 7),
    cancelContinue: vi.fn(),
    switchAgentLocation: vi.fn(async (_id: string, route: { agentDeviceId: string | null; providerId: string | null }) => {
      row.agentDeviceId = route.agentDeviceId;
      row.providerId = route.providerId;
    }),
    isTurnRunning: vi.fn(() => false),
    hasLiveSession: vi.fn(() => options.live ?? true),
    continueSession: vi.fn(async () => 'resumed' as const),
    fallback: vi.fn(),
    readResetAt: vi.fn((): number | null => 5_000),
    now: () => 1_000,
    // 等原电脑恢复时的退避不真等。
    sleep: vi.fn(async (_ms: number) => {}),
    log: { info: vi.fn(), warn: vi.fn() },
  } satisfies ProviderGroupServiceDeps;
  return { service: createProviderGroupService(deps), deps, remote, row, bindings, released, probe };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const START = { sessionId: 's1', agentKind: 'claude-code' as const, model: MODEL };

describe('assigning through a group on another computer', () => {
  it('asks the group computer and connects straight to the chosen computer', async () => {
    const h = harness();
    const context = await h.service.assignBeforeStart(START);
    expect(h.remote.pick).toHaveBeenCalledWith(OWNER, expect.objectContaining({ sessionId: 's1', providerId: 'anthropic', exclude: [] }));
    expect(context).toMatchObject({
      groupDeviceId: OWNER,
      overrideRoute: true,
      route: { agentDeviceId: 'studio', providerId: 'anthropic-1a2b3c4d' },
    });
    expect(h.deps.persistRoute).toHaveBeenCalledWith('s1', { agentDeviceId: 'studio', providerId: 'anthropic-1a2b3c4d' });
    expect(h.bindings.get('s1')).toMatchObject({ providerId: 'anthropic', memberKey: STUDIO.key, groupDeviceId: OWNER });
  });

  it('maps the group computer itself, this computer and shares to the right place', async () => {
    const cases: Array<[ProviderGroupMember, { agentDeviceId: string | null; providerId: string }]> = [
      [OWNER_LOCAL, { agentDeviceId: OWNER, providerId: 'anthropic' }],
      [SELF, { agentDeviceId: null, providerId: 'anthropic' }],
      [SHARED, { agentDeviceId: 'share:s1', providerId: 'anthropic' }],
    ];
    for (const [picked, route] of cases) {
      const h = harness({ picks: [picked] });
      const context = await h.service.assignBeforeStart(START);
      expect(context?.route).toEqual(route);
    }
  });

  it('runs straight on the group computer when it cannot answer or has no group', async () => {
    for (const options of [{ config: undefined }, { config: null }, { picks: ['none' as const] }, { picks: [new Error('link down')] }]) {
      const h = harness(options);
      expect(await h.service.assignBeforeStart(START)).toBeNull();
      expect(h.deps.persistRoute).not.toHaveBeenCalled();
      expect(h.bindings.size).toBe(0);
    }
  });

  it('reports a clear error when no computer in the group can take the task', async () => {
    const h = harness({ picks: ['unavailable'] });
    await expect(h.service.assignBeforeStart(START)).rejects.toThrow(PROVIDER_GROUP_UNAVAILABLE_ERROR);
  });

  it('takes in a task that already ran on the group computer without moving it, and leaves shares alone', async () => {
    const ran = harness({ row: { sdkSessionId: 'native-1' } });
    expect(await ran.service.assignBeforeStart(START)).toBeNull();
    expect(ran.remote.pick).not.toHaveBeenCalled();
    expect(ran.deps.persistRoute).not.toHaveBeenCalled();
    expect(ran.bindings.get('s1')).toMatchObject({ providerId: 'anthropic', memberKey: OWNER_LOCAL.key, groupDeviceId: OWNER });

    // 运行过之后才换到组那一项的老任务(换过去后还没有原生会话，但已经有过回复)也一样。
    const switchedIn = harness();
    switchedIn.deps.hasAssistantHistory.mockResolvedValue(true);
    expect(await switchedIn.service.assignBeforeStart(START)).toBeNull();
    expect(switchedIn.remote.pick).not.toHaveBeenCalled();
    expect(switchedIn.bindings.get('s1')).toMatchObject({ memberKey: OWNER_LOCAL.key, groupDeviceId: OWNER });

    for (const row of [{ agentDeviceId: 'share:s9' }, { providerId: null }]) {
      const h = harness({ row });
      expect(await h.service.assignBeforeStart(START)).toBeNull();
      expect(h.remote.pick).not.toHaveBeenCalled();
      expect(h.bindings.size).toBe(0);
    }
  });

  it('leaves an old task alone when the computer has no group, cannot answer, or the task was released from it', async () => {
    for (const options of [{ config: null }, { config: undefined }]) {
      const h = harness({ ...options, row: { sdkSessionId: 'native-1' } });
      expect(await h.service.assignBeforeStart(START)).toBeNull();
      expect(h.bindings.size).toBe(0);
    }
    const released = harness({ row: { sdkSessionId: 'native-1' } });
    released.released.set('s1', { providerId: 'anthropic', groupDeviceId: OWNER });
    expect(await released.service.assignBeforeStart(START)).toBeNull();
    expect(released.bindings.size).toBe(0);
    expect(released.remote.readGroup).not.toHaveBeenCalled();
    // 解除的是别的组：不影响这个组。
    const otherGroup = harness({ row: { sdkSessionId: 'native-1' } });
    otherGroup.released.set('s1', { providerId: 'anthropic', groupDeviceId: null });
    await otherGroup.service.assignBeforeStart(START);
    expect(otherGroup.bindings.get('s1')).toMatchObject({ groupDeviceId: OWNER });
  });

  it('starts as usual without waiting when the group computer does not answer in time for an old task', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ row: { sdkSessionId: 'native-1' } });
      h.remote.readGroup.mockImplementation(() => new Promise(() => undefined));
      const done = vi.fn();
      void h.service.assignBeforeStart(START).then(done);
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_ADOPT_TIMEOUT_MS);
      expect(done).toHaveBeenCalledWith(null);
      expect(h.bindings.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the binding while the group computer is unreachable and drops it once the group is gone', async () => {
    const unreachable = harness({ config: undefined, row: { agentDeviceId: 'studio', providerId: STUDIO.providerId } });
    unreachable.bindings.set('s1', { providerId: 'anthropic', memberKey: STUDIO.key, groupDeviceId: OWNER, at: 1 });
    expect(await unreachable.service.assignBeforeStart(START)).toBeNull();
    expect(unreachable.bindings.has('s1')).toBe(true);

    const gone = harness({ config: null, row: { agentDeviceId: 'studio', providerId: STUDIO.providerId } });
    gone.bindings.set('s1', { providerId: 'anthropic', memberKey: STUDIO.key, groupDeviceId: OWNER, at: 1 });
    expect(await gone.service.assignBeforeStart(START)).toBeNull();
    expect(gone.bindings.has('s1')).toBe(false);
  });

  it('tries the next computer when the chosen one does not start', async () => {
    const h = harness({ picks: [STUDIO, SHARED] });
    const context = await h.service.assignBeforeStart(START);
    const next = await h.service.nextAfterStartFailure(context!, new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] gone'));
    expect(h.remote.pick).toHaveBeenLastCalledWith(OWNER, expect.objectContaining({ exclude: [STUDIO.key] }));
    // 连不上只由本机自己避开，不替全组冷却那台。
    expect(h.remote.cool).not.toHaveBeenCalled();
    expect(next?.route).toEqual({ agentDeviceId: 'share:s1', providerId: 'anthropic' });
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: SHARED.key, groupDeviceId: OWNER });
  });

  it('drops the binding when the group is deleted before the agent starts', async () => {
    const h = harness({ picks: [STUDIO] });
    const context = await h.service.assignBeforeStart(START);
    expect(h.bindings.size).toBe(1);
    h.remote.readGroup.mockResolvedValue(null);
    expect(await h.service.nextAfterStartFailure(context!, new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] gone'))).toBeNull();
    expect(h.bindings.size).toBe(0);
  });
});

describe('switching computers within a group on another computer', () => {
  function bound(options: Parameters<typeof harness>[0] = {}) {
    const h = harness({ row: { agentDeviceId: 'studio', providerId: STUDIO.providerId, sdkSessionId: 'native-1' }, ...options });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: STUDIO.key, groupDeviceId: OWNER, at: 1 });
    return h;
  }

  it('reports the usage limit to the group computer, moves the task and continues with names', async () => {
    const h = bound({ picks: [OWNER_LOCAL] });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(h.remote.cool).toHaveBeenCalledWith(OWNER, { providerId: 'anthropic', memberKey: STUDIO.key, cause: 'usage-limit', resetAt: 5_000 });
    expect(h.remote.pick).toHaveBeenCalledWith(OWNER, expect.objectContaining({ exclude: expect.arrayContaining([STUDIO.key]) }));
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: OWNER, providerId: 'anthropic' }), expect.anything());
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 7, expect.objectContaining({
      agentSwitch: { from: 'Studio', to: 'Mac Mini', cause: 'usage-limit' },
    }));
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: 'local', groupDeviceId: OWNER });
    expect(h.deps.fallback).not.toHaveBeenCalled();
  });

  it('tells the model list which group the task is in only while it runs on the bound computer', async () => {
    const h = bound();
    expect(await h.service.sessionGroup('s1')).toEqual({ groupDeviceId: OWNER, providerId: 'anthropic' });
    // 挪到了组外(或还没核对的别处)：不按组显示。
    h.row.agentDeviceId = 'elsewhere';
    expect(await h.service.sessionGroup('s1')).toBeNull();
    // 任务就在这台(组里的「我的电脑」)运行。
    h.row.agentDeviceId = null;
    h.row.providerId = 'anthropic';
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: SELF.key, groupDeviceId: OWNER, at: 1 });
    expect(await h.service.sessionGroup('s1')).toEqual({ groupDeviceId: OWNER, providerId: 'anthropic' });
    expect(await h.service.sessionGroup('no-binding')).toBeNull();
    expect(h.remote.readGroup).not.toHaveBeenCalled();
  });

  it('still switches when the task was just moved to another computer in the group', async () => {
    // 2026-10-11：交接到 Studio 后，任务又被挪回组所在电脑(绑定还写着 Studio)，那台撞到周上限。
    const h = bound({ row: { agentDeviceId: OWNER, providerId: 'anthropic', sdkSessionId: 'native-2' }, picks: [STUDIO] });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(h.remote.cool).toHaveBeenCalledWith(OWNER, expect.objectContaining({ memberKey: 'local', cause: 'usage-limit' }));
    expect(h.remote.pick).toHaveBeenCalledWith(OWNER, expect.objectContaining({ exclude: expect.arrayContaining(['local']) }));
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: 'studio' }), expect.anything());
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: STUDIO.key, groupDeviceId: OWNER });
    expect(h.deps.fallback).not.toHaveBeenCalled();
  });

  it('only avoids an unreachable computer itself instead of cooling it for the whole group', async () => {
    const h = bound({ picks: [SELF] });
    await h.service.onTurnError('s1', { message: '[REMOTE_AGENT_DEVICE_UNREACHABLE] gone' }, 3);
    // 先等它恢复：本机现读那台(组内电脑坐标照本机的写法)，重试用完才换。
    expect(h.probe).toHaveBeenCalledWith('studio', STUDIO.providerId);
    expect(h.deps.sleep).toHaveBeenCalledTimes(PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
    expect(h.remote.cool).not.toHaveBeenCalled();
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith('s1', expect.objectContaining({ agentDeviceId: null, providerId: 'anthropic' }), expect.anything());
  });

  it('continues on the same computer when it comes back, without asking the group computer for another', async () => {
    const h = bound({ picks: [SELF] });
    h.probe.mockResolvedValueOnce('offline').mockResolvedValueOnce('ok');
    await h.service.onTurnError('s1', { message: '[REMOTE_AGENT_DEVICE_UNREACHABLE] gone' }, 3);
    expect(h.remote.pick).not.toHaveBeenCalled();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: STUDIO.key, groupDeviceId: OWNER });
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 7, expect.objectContaining({
      agentReconnect: { computer: 'Studio' },
    }));
  });

  it('still waits for its own computer when the group computer cannot be read, but cannot switch', async () => {
    // 常见是任务就跑在组所在电脑上、它自己断了：组读不到，只按任务记录里的位置等它恢复。
    const back = bound({ config: undefined });
    back.probe.mockResolvedValueOnce('offline').mockResolvedValueOnce('ok');
    await back.service.onTurnError('s1', { message: '[REMOTE_AGENT_DEVICE_UNREACHABLE] gone' }, 3);
    expect(back.probe).toHaveBeenCalledWith('studio', STUDIO.providerId);
    expect(back.deps.continueSession).toHaveBeenCalledWith('s1', 7, expect.objectContaining({
      agentReconnect: { computer: '' },
    }));
    expect(back.deps.fallback).not.toHaveBeenCalled();
    expect(back.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(back.bindings.has('s1')).toBe(true);

    // 等不到：换不了电脑，交回原有处理。
    const gone = bound({ config: undefined });
    await gone.service.onTurnError('s1', { message: '[REMOTE_AGENT_DEVICE_UNREACHABLE] gone' }, 3);
    expect(gone.deps.sleep).toHaveBeenCalledTimes(PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
    expect(gone.deps.fallback).toHaveBeenCalledTimes(1);
    expect(gone.deps.switchAgentLocation).not.toHaveBeenCalled();
  });

  it('waits before sending for its own computer when the group computer cannot be read and the session must be reopened', async () => {
    const reopen = bound({ config: undefined });
    Object.assign(reopen.deps, { hasLiveSession: () => false });
    const progress = vi.fn();
    await reopen.service.beforeSend('s1', { progress });
    expect(reopen.probe).toHaveBeenCalledWith('studio', STUDIO.providerId);
    expect(progress).toHaveBeenCalledTimes(PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
    expect(progress).not.toHaveBeenCalledWith('switching');
    expect(reopen.deps.switchAgentLocation).not.toHaveBeenCalled();

    // 会话还开着：照常发送，不现读。
    const live = bound({ config: undefined });
    await live.service.beforeSend('s1');
    expect(live.probe).not.toHaveBeenCalled();
  });

  it('hands the error back when the group computer cannot be reached', async () => {
    const h = bound({ config: undefined });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(h.deps.fallback).toHaveBeenCalled();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.bindings.has('s1')).toBe(true);
  });

  it('releases the task as soon as the group computer confirms the group was deleted', async () => {
    const failing = bound({ config: null });
    failing.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(failing.bindings.has('s1')).toBe(false);
    expect(failing.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(failing.deps.fallback).toHaveBeenCalled();
    expect(failing.released.get('s1')).toEqual({ providerId: 'anthropic', groupDeviceId: OWNER });
    // 重建同一个组后，即使任务挪到了组那一项，也不再自动纳入(§9.4)。
    failing.remote.readGroup.mockResolvedValue({ strategy: 'least', autoSwitch: true, members: [OWNER_LOCAL, STUDIO] });
    Object.assign(failing.row, { agentDeviceId: OWNER, providerId: 'anthropic' });
    failing.service.onTurnError('s1', { sdkError: 'rate_limit' }, 4);
    await flush();
    expect(failing.bindings.has('s1')).toBe(false);
    expect(failing.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(failing.deps.fallback).toHaveBeenCalledTimes(2);

    const sending = bound({ config: null });
    await sending.service.beforeSend('s1');
    expect(sending.bindings.has('s1')).toBe(false);
    expect(sending.deps.switchAgentLocation).not.toHaveBeenCalled();
  });

  it('sends as usual without waiting when the group computer does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const h = bound();
      h.remote.readGroup.mockImplementation(() => new Promise(() => undefined));
      const done = vi.fn();
      void h.service.beforeSend('s1').then(done);
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_BEFORE_SEND_TIMEOUT_MS);
      expect(done).toHaveBeenCalled();
      expect(h.bindings.has('s1')).toBe(true);
      expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops following the group once the user moved the task elsewhere', async () => {
    const h = bound({ row: { agentDeviceId: 'elsewhere', providerId: 'openai', sdkSessionId: 'native-1' } });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(h.bindings.has('s1')).toBe(false);
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.fallback).toHaveBeenCalled();
    // 挪到组外不算解除：挪回组那一项时照常纳入。
    expect(h.released.has('s1')).toBe(false);
  });

  it('does not take a task back once its computer was removed from the group', async () => {
    const h = bound({ config: { strategy: 'least', autoSwitch: true, members: [OWNER_LOCAL, SELF] } });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(h.bindings.has('s1')).toBe(false);
    expect(h.released.get('s1')).toEqual({ providerId: 'anthropic', groupDeviceId: OWNER });
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.fallback).toHaveBeenCalled();
  });

  it('moves the task before sending when the group computer says its computer is offline', async () => {
    const h = bound({ view: { [STUDIO.key]: 'offline' }, picks: [SHARED] });
    await h.service.beforeSend('s1');
    // 现读一次仍离线，等满重试次数才换。
    expect(h.probe).toHaveBeenCalledWith('studio', STUDIO.providerId);
    expect(h.deps.sleep).toHaveBeenCalledTimes(PROVIDER_GROUP_RECONNECT_MAX_ATTEMPTS);
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ agentDeviceId: 'share:s1', providerId: 'anthropic' }),
      { beforeSend: true },
    );
    const healthy = bound();
    await healthy.service.beforeSend('s1');
    expect(healthy.deps.switchAgentLocation).not.toHaveBeenCalled();
  });
});

describe('old tasks already running on the group computer', () => {
  it('takes the task in when it hits the usage limit there, then moves it and continues', async () => {
    const h = harness({ row: { sdkSessionId: 'native-1' }, picks: [STUDIO] });
    h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
    await flush();
    expect(h.remote.cool).toHaveBeenCalledWith(OWNER, { providerId: 'anthropic', memberKey: OWNER_LOCAL.key, cause: 'usage-limit', resetAt: 5_000 });
    expect(h.deps.switchAgentLocation).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ agentDeviceId: 'studio', providerId: STUDIO.providerId }),
      expect.anything(),
    );
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 7, expect.objectContaining({
      agentSwitch: { from: 'Mac Mini', to: 'Studio', cause: 'usage-limit' },
    }));
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: STUDIO.key, groupDeviceId: OWNER });
    expect(h.deps.fallback).not.toHaveBeenCalled();
  });

  it('retries group adoption after a startup failure when the initial group read timed out', async () => {
    const h = harness({ row: { sdkSessionId: 'native-1' }, live: false });
    h.remote.readGroup.mockResolvedValueOnce(undefined);

    const context = await h.service.assignBeforeStart(START);
    expect(context).toMatchObject({
      pendingGroupAdoption: true,
      member: { key: 'local' },
      route: { agentDeviceId: OWNER, providerId: OWNER_LOCAL.providerId },
    });
    expect(h.bindings.size).toBe(0);

    const next = await h.service.nextAfterStartFailure(
      context!,
      new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] group computer is gone'),
    );
    expect(next?.member.key).toBe(STUDIO.key);
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: STUDIO.key, groupDeviceId: OWNER });
  });

  it('keeps an existing bound task pending when its group read times out before reopening', async () => {
    const h = harness({ live: false });
    h.bindings.set('s1', { providerId: 'anthropic', memberKey: OWNER_LOCAL.key, groupDeviceId: OWNER, at: 1 });
    h.remote.readGroup.mockResolvedValueOnce(undefined);

    const context = await h.service.assignBeforeStart(START);
    expect(context).toMatchObject({
      pendingGroupAdoption: true,
      member: { key: OWNER_LOCAL.key },
      route: { agentDeviceId: OWNER, providerId: OWNER_LOCAL.providerId },
    });

    const next = await h.service.nextAfterStartFailure(
      context!,
      new Error('[REMOTE_AGENT_DEVICE_UNREACHABLE] group computer is gone'),
    );
    expect(next?.member.key).toBe(STUDIO.key);
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: STUDIO.key, groupDeviceId: OWNER });
  });

  it('returns a start context for an old task whose live session is gone, so startup failure can move it', async () => {
    const h = harness({ row: { sdkSessionId: 'native-1' }, live: false, picks: [STUDIO] });
    const context = await h.service.assignBeforeStart(START);

    expect(context).toMatchObject({
      member: { key: OWNER_LOCAL.key },
      route: { agentDeviceId: OWNER, providerId: OWNER_LOCAL.providerId },
      groupDeviceId: OWNER,
    });
    expect(h.bindings.get('s1')).toMatchObject({ memberKey: OWNER_LOCAL.key, groupDeviceId: OWNER });

    const next = await h.service.nextAfterStartFailure(
      context!,
      new Error('[REMOTE_AGENT_UNAVAILABLE] group computer is gone'),
    );
    expect(next?.member.key).toBe(STUDIO.key);
    expect(next?.route).toEqual({ agentDeviceId: STUDIO.agentDeviceId, providerId: STUDIO.providerId });
  });

  it('hands the error back when the task is not on the group, was released, or is not eligible', async () => {
    const noGroup = harness({ config: null, row: { sdkSessionId: 'native-1' } });
    const released = harness({ row: { sdkSessionId: 'native-1' } });
    released.released.set('s1', { providerId: 'anthropic', groupDeviceId: OWNER });
    const ineligible = harness({ row: { sdkSessionId: 'native-1' } });
    ineligible.deps.isFailoverEligible.mockResolvedValue(false);
    for (const h of [noGroup, released, ineligible]) {
      h.service.onTurnError('s1', { sdkError: 'rate_limit' }, 3);
      await flush();
      expect(h.bindings.size).toBe(0);
      expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
      expect(h.deps.fallback).toHaveBeenCalledWith('s1', { sdkError: 'rate_limit' }, 3);
    }
  });

  it('does not take the task in for failures any computer would hit', async () => {
    const h = harness({ row: { sdkSessionId: 'native-1' } });
    h.service.onTurnError('s1', { message: 'prompt is too long', sdkError: 'invalid_request' }, 3);
    await flush();
    expect(h.remote.readGroup).not.toHaveBeenCalled();
    expect(h.bindings.size).toBe(0);
    expect(h.deps.fallback).toHaveBeenCalledTimes(1);
  });
});
