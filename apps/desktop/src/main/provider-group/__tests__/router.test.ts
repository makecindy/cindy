/**
 * 组内电脑的运行数(provider-groups.md §5、§10)：分享来的电脑报来本账号在那台实际跑着几个(含不经组直接用的)，
 * 设置页与分配用同一个数，取它与经组计数中较大的。
 */
import type { ProviderView } from '@cindy/model-providers';
import type { RemoteAgentCaps } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import type { ProviderGroupBinding } from '../bindings';
import type { DeviceLinkDeviceView } from '../../../shared/deviceLinkIpc';
import { createProviderGroupDirectory, type ProviderGroupDirectory, type ResolvedProviderGroupMember } from '../directory';
import { createProviderGroupRouter, PROVIDER_GROUP_PICK_QUICK_MS, type ProviderGroupRouterDeps } from '../router';
import { SHARED_GROUP_STATUS_CAPS_CACHE_MS, SHARED_GROUP_STATUS_TIMEOUT_MS } from '../sharedStatus';

const MODEL = 'claude-opus-5-5';

function view(id: string): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function member(key: string, kind: ProviderGroupMember['kind'], agentDeviceId: string | null, limit = 4): ProviderGroupMember {
  return { key, kind, agentDeviceId, providerId: 'anthropic', limit, weight: 1, paused: false };
}

const LOCAL = member('local', 'local', null);
const SHARE_A = member('share:a:anthropic', 'share', 'share:a', 2);
const SHARE_B = member('share:b:anthropic', 'share', 'share:b');

function harness(
  reported: Record<string, number>,
  bindings: Record<string, ProviderGroupBinding> = {},
  running: string[] = [],
  config: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [SHARE_A, SHARE_B, LOCAL] },
  overrides: Partial<ProviderGroupRouterDeps> = {},
) {
  const directory: ProviderGroupDirectory = {
    async resolveMembers(_providerId, current) {
      return current.members.map((m): ResolvedProviderGroupMember => ({
        member: m,
        label: m.key,
        state: 'ok',
        view: view(m.providerId),
        ...(reported[m.key] !== undefined ? { reportedRunning: reported[m.key] } : {}),
      }));
    },
    async listCandidates() {
      return [];
    },
    async readDeviceCatalog() {
      return [];
    },
    async probe() {
      return 'ok' as const;
    },
    memberLabel: (m) => m.key,
    invalidate: () => undefined,
  };
  return createProviderGroupRouter({
    directory,
    readGroup: (id) => (id === 'anthropic' ? config : null),
    listBindings: () => bindings,
    isTurnRunning: (sessionId) => running.includes(sessionId),
    now: () => 1_000,
    random: () => 0,
    ...overrides,
  });
}

describe('provider group details capability reader lifetime', () => {
  const devices = Array.from({ length: 5 }, (_, index) => member(`device:${index}:anthropic`, 'device', `device-${index}`, 1));
  const supportedCaps = { virtualWorkspace: true, guestRelay: true } as RemoteAgentCaps;
  const olderCaps = { virtualWorkspace: true } as RemoteAgentCaps;
  const detailsOptions = { includeGuestSupport: true };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function detailsRouter(readCaps: NonNullable<ProviderGroupRouterDeps['readCaps']>) {
    return harness({}, {}, [], undefined, {
      readGroup: () => ({ strategy: 'least', autoSwitch: true, members: devices }), readCaps,
    });
  }

  it('keeps four physical probes across overlapping details and the next refresh', async () => {
    const readCaps = vi.fn<NonNullable<ProviderGroupRouterDeps['readCaps']>>(() => new Promise(() => undefined));
    const router = detailsRouter(readCaps);
    const first = router.view('anthropic', detailsOptions);
    const overlapping = router.view('anthropic', detailsOptions);
    await vi.advanceTimersByTimeAsync(0);
    expect(readCaps).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    for (const details of await Promise.all([first, overlapping])) {
      expect(details.members.map((entry) => entry.guestSupport)).toEqual(Array(5).fill('unknown'));
    }

    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_CAPS_CACHE_MS - SHARED_GROUP_STATUS_TIMEOUT_MS);
    const refreshed = router.view('anthropic', detailsOptions);
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect((await refreshed).members.map((entry) => entry.guestSupport)).toEqual(Array(5).fill('unknown'));
    expect(readCaps).toHaveBeenCalledTimes(4);
  });

  it('uses late results on the next refresh so a fifth computer can be probed', async () => {
    const readCaps = vi.fn<NonNullable<ProviderGroupRouterDeps['readCaps']>>((current) => current.agentDeviceId === devices[4].agentDeviceId
      ? Promise.resolve(supportedCaps)
      : new Promise((resolve) => setTimeout(() => resolve(supportedCaps), SHARED_GROUP_STATUS_TIMEOUT_MS + 1_000)));
    const router = detailsRouter(readCaps);
    const first = router.view('anthropic', detailsOptions);
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect((await first).members.map((entry) => entry.guestSupport)).toEqual(Array(5).fill('unknown'));
    expect(readCaps).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_CAPS_CACHE_MS - SHARED_GROUP_STATUS_TIMEOUT_MS);
    const refreshed = router.view('anthropic', detailsOptions);
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_TIMEOUT_MS);
    expect((await refreshed).members.map((entry) => entry.guestSupport)).toEqual(Array(5).fill('supported'));
    expect(readCaps).toHaveBeenCalledTimes(5);
    expect(readCaps).toHaveBeenLastCalledWith(devices[4]);
  });

  it('caches capabilities for 15 seconds but still reads the current running state', async () => {
    const device = devices[0];
    const reported = { [device.key]: 0 };
    const readCaps = vi.fn<NonNullable<ProviderGroupRouterDeps['readCaps']>>().mockResolvedValue(supportedCaps);
    const router = harness(reported, {}, [], undefined, {
      readGroup: () => ({ strategy: 'least', autoSwitch: true, members: [device] }), readCaps,
    });
    expect((await router.view('anthropic', detailsOptions)).members[0]).toMatchObject({
      guestSupport: 'supported', state: 'available', running: 0,
    });
    reported[device.key] = 1;
    readCaps.mockResolvedValue(olderCaps);
    await vi.advanceTimersByTimeAsync(SHARED_GROUP_STATUS_CAPS_CACHE_MS - 1);
    expect((await router.view('anthropic', detailsOptions)).members[0]).toMatchObject({
      guestSupport: 'supported', state: 'full', running: 1,
    });
    expect(readCaps).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect((await router.view('anthropic', detailsOptions)).members[0]).toMatchObject({
      guestSupport: 'needs-update', state: 'full', running: 1,
    });
    expect(readCaps).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight device probe across different groups in the same router', async () => {
    const device = devices[0];
    const otherProvider = { ...device, key: 'device:0:openai', providerId: 'openai' };
    const readCaps = vi.fn<NonNullable<ProviderGroupRouterDeps['readCaps']>>(() =>
      new Promise((resolve) => setTimeout(() => resolve(supportedCaps), 1)));
    const router = harness({}, {}, [], undefined, {
      readGroup: (providerId) => ({
        strategy: 'least', autoSwitch: true, members: [providerId === 'anthropic' ? device : otherProvider],
      }),
      readCaps,
    });
    const first = router.view('anthropic', detailsOptions);
    const other = router.view('openai', detailsOptions);
    await vi.advanceTimersByTimeAsync(0);
    expect(readCaps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    for (const details of await Promise.all([first, other])) {
      expect(details.members[0].guestSupport).toBe('supported');
    }
    await router.view('openai', detailsOptions);
    expect(readCaps).toHaveBeenCalledTimes(1);
  });

  it('isolates in-flight probes and caches between router account runtimes', async () => {
    let finishOldProbe!: (caps: RemoteAgentCaps) => void;
    const readCaps = vi.fn<NonNullable<ProviderGroupRouterDeps['readCaps']>>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldProbe = resolve; }))
      .mockResolvedValue(olderCaps);
    const overrides = {
      readGroup: (): ProviderGroupConfig => ({ strategy: 'least', autoSwitch: true, members: [devices[0]] }), readCaps,
    };
    const oldRouter = harness({}, {}, [], undefined, overrides);
    const first = oldRouter.view('anthropic', detailsOptions);
    await vi.advanceTimersByTimeAsync(0);
    const nextRouter = harness({}, {}, [], undefined, overrides);
    expect((await nextRouter.view('anthropic', detailsOptions)).members[0].guestSupport).toBe('needs-update');
    finishOldProbe(supportedCaps);
    expect((await first).members[0].guestSupport).toBe('supported');
    expect((await oldRouter.view('anthropic', detailsOptions)).members[0].guestSupport).toBe('supported');
    expect(readCaps).toHaveBeenCalledTimes(2);
  });
});

describe('own tasks and incoming tasks', () => {
  it.each(['least', 'order', 'round', 'weight'] as const)('assigns own tasks by %s like incoming tasks, letting them use a paused local computer', async (strategy) => {
    const input = { providerId: 'anthropic', agentKind: 'claude-code' as const, model: MODEL };
    // 本机满载：本机任务也按并发上限分到别的电脑，不再固定留在本机。
    const full: ProviderGroupConfig = { strategy, autoSwitch: true, members: [SHARE_A, { ...LOCAL, paused: true }] };
    const fullRouter = harness({ [LOCAL.key]: 8 }, {}, [], full);
    expect(await fullRouter.pick({ ...input, localTask: true })).toMatchObject({ kind: 'member', member: { key: SHARE_A.key } });
    // 本机暂停对外分配：外部任务不分过来，本机任务照常可以选它。
    const paused: ProviderGroupConfig = { strategy, autoSwitch: true, members: [{ ...LOCAL, paused: true }, SHARE_A] };
    const pausedRouter = harness({}, {}, [], paused);
    expect(await pausedRouter.pick({ ...input, localTask: true })).toMatchObject({ kind: 'member', member: { key: LOCAL.key } });
    expect(await pausedRouter.pick(input)).toMatchObject({ kind: 'member', member: { key: SHARE_A.key } });
    expect(paused.members[0].paused).toBe(true);
  });

  it('lets own tasks take their turn in round-robin allocation', async () => {
    const config: ProviderGroupConfig = { strategy: 'round', autoSwitch: true, members: [SHARE_A, SHARE_B, LOCAL] };
    const router = harness({}, {}, [], config);
    const input = { providerId: 'anthropic', agentKind: 'claude-code' as const, model: MODEL };
    expect(await router.pick(input)).toMatchObject({ kind: 'member', member: { key: SHARE_A.key } });
    expect(await router.pick({ ...input, localTask: true })).toMatchObject({ kind: 'member', member: { key: SHARE_B.key } });
    expect(await router.pick(input)).toMatchObject({ kind: 'member', member: { key: LOCAL.key } });
  });

  it.each(['cooling', 'excluded'] as const)('falls back to the group when this computer is %s', async (reason) => {
    const router = harness({ [LOCAL.key]: 0, [SHARE_A.key]: 1 });
    if (reason === 'cooling') router.markCooling('anthropic', LOCAL.key, 100_000);
    expect(await router.pick({
      providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, localTask: true,
      ...(reason === 'excluded' ? { exclude: new Set([LOCAL.key]) } : {}),
    })).toMatchObject({ kind: 'member', member: { key: SHARE_B.key } });
  });
});

describe('provider group running count', () => {
  it('only probes sharing support for details and keeps an older computer usable by its owner', async () => {
    const device = member('device:old:anthropic', 'device', 'old');
    const readCaps = vi.fn(async () => ({ virtualWorkspace: true }) as RemoteAgentCaps);
    const router = harness({}, {}, [], undefined, {
      readGroup: () => ({ strategy: 'least', autoSwitch: true, members: [device] }), readCaps,
    });
    expect(await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL })).toMatchObject({ kind: 'member' });
    await router.view('anthropic');
    expect(readCaps).not.toHaveBeenCalled();
    const details = await router.view('anthropic', { includeGuestSupport: true });
    expect(details.members[0]).toMatchObject({ state: 'available', guestSupport: 'needs-update' });
    expect(readCaps).toHaveBeenCalledTimes(1);
    expect(await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL })).toMatchObject({ kind: 'member' });
    expect(router.coolingUntil('anthropic', device.key)).toBeNull();
  });

  it('reports failed capability checks as unknown without changing ordinary availability', async () => {
    const router = harness({}, {}, [], undefined, { readCaps: async () => { throw new Error('offline'); } });
    const details = await router.view('anthropic', { includeGuestSupport: true });
    expect(details.members.map((m) => [m.state, m.guestSupport])).toEqual([
      ['available', 'unknown'], ['available', 'unknown'], ['available', 'supported'],
    ]);
  });

  it('shows what a shared computer reports for this account, including tasks that did not go through the group', async () => {
    const router = harness({ [SHARE_A.key]: 2, [SHARE_B.key]: 1 });
    const members = (await router.view('anthropic')).members;
    expect(members.map((m) => [m.key, m.running, m.state])).toEqual([
      [SHARE_A.key, 2, 'full'],
      [SHARE_B.key, 1, 'available'],
      [LOCAL.key, 0, 'available'],
    ]);
  });

  it('keeps counting tasks the group assigned that the report does not include yet', async () => {
    const router = harness(
      { [SHARE_B.key]: 0 },
      { t1: { providerId: 'anthropic', memberKey: SHARE_B.key, at: 1 } },
      ['t1'],
    );
    const shareB = (await router.view('anthropic')).members.find((m) => m.key === SHARE_B.key);
    expect(shareB?.running).toBe(1);
  });

  it('assigns new tasks by the same count the settings page shows', async () => {
    // 两台分享来的电脑经组都没分过任务，但 A 上本账号已经直接跑着 1 个：最少占用选本机或 B，不选 A。
    const router = harness({ [SHARE_A.key]: 1, [SHARE_B.key]: 0 }, {}, []);
    const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL });
    expect(pick).toMatchObject({ kind: 'member', member: { key: SHARE_B.key } });
  });
});

describe('provider group picks for this computer’s own tasks', () => {
  it('reserves the chosen computer until the task starts, so tasks opened together spread out', async () => {
    const bindings: Record<string, ProviderGroupBinding> = {};
    const running: string[] = [];
    const router = harness({}, bindings, running);
    const first = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, reserveFor: 's1' });
    const second = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, reserveFor: 's2' });
    expect(first.kind === 'member' && second.kind === 'member' && first.member.key !== second.member.key).toBe(true);

    // 开始运行一轮之后按绑定计，不再重复计那份临时占用。
    if (first.kind !== 'member') throw new Error('expected a member');
    bindings.s1 = { providerId: 'anthropic', memberKey: first.member.key, at: 1 };
    running.push('s1');
    expect(router.running('anthropic', first.member.key)).toBe(1);
  });
});

describe('provider group quick picks with busy usable computers', () => {
  const FAST = member('device:fast:anthropic', 'device', 'fast');
  const SLOW = member('device:slow:anthropic', 'device', 'slow');

  function quickRouter(localLoad: number | Promise<number | null>, fastLoad: number | null, localView = view('anthropic'), localGroupLoad = 0) {
    const config: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [LOCAL, FAST, SLOW] };
    const devices = ['fast', 'slow'].map((deviceId): DeviceLinkDeviceView => ({
      deviceId, name: deviceId, platform: 'win32', appVersion: '1.0.0', lastSeenAt: null,
      online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false,
    }));
    const localRunning = vi.fn(async () => localLoad);
    const readDeviceProviders = vi.fn((deviceId: string) => deviceId === 'fast' && fastLoad !== null
      ? Promise.resolve([view('anthropic')])
      : new Promise<ProviderView[]>(() => undefined));
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [localView],
      localDeviceName: () => 'local',
      localRunning,
      listDevices: async () => devices,
      readDeviceProviders,
      listReceivedShares: () => [],
      isMobilePlatform: () => false,
      now: () => 1_000,
    });
    const router = createProviderGroupRouter({
      directory, readGroup: () => config, listBindings: () => ({}), isTurnRunning: () => false,
      externalRunning: (_providerId, key) => key === FAST.key ? fastLoad ?? 0 : key === LOCAL.key ? localGroupLoad : 0,
      now: () => 1_000, random: () => 0,
    });
    return { router, config, localRunning, readDeviceProviders };
  }

  it.each([
    { fastLoad: null, expected: LOCAL.key },
    { fastLoad: 1, expected: FAST.key },
  ].flatMap((scenario) => [false, true].map((own) => ({ ...scenario, own }))))(
    'keeps local availability and group counts when its load read stalls (fast load=$fastLoad, own task=$own)',
    async ({ fastLoad, expected, own }) => {
      vi.useFakeTimers();
      try {
        const localLoad = new Promise<number | null>(() => undefined);
        const { router, config } = quickRouter(localLoad, fastLoad, view('anthropic'), 2);
        config.strategy = 'least';
        const done = vi.fn();
        void router.pick({
          providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, ...(own ? { localTask: true as const } : {}),
        }).then(done);
        await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS - 1);
        expect(done).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          kind: 'member', member: expect.objectContaining({ key: expected }),
        }));
        const resolved = done.mock.calls[0][0].resolved as ResolvedProviderGroupMember[];
        const local = resolved.find((member) => member.member.key === LOCAL.key);
        expect(local).toMatchObject({ state: 'ok' });
        expect(local?.reportedRunning).toBeUndefined();
        expect(router.running('anthropic', LOCAL.key)).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['disconnected', 'wrong-model'] as const)('falls back within the quick window for an own task when local is %s', async (reason) => {
    vi.useFakeTimers();
    try {
      const localView = view('anthropic');
      if (reason === 'disconnected') localView.connected = false;
      else localView.models = { 'claude-code': [] };
      const { router } = quickRouter(new Promise(() => undefined), 0, localView);
      const done = vi.fn();
      void router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, localTask: true }).then(done);
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS);
      expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        kind: 'member', member: expect.objectContaining({ key: FAST.key }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  // 本机任务与外部任务走同一条快速选择(本机任务只是不受本机的对外暂停限制)。
  it.each([
    { label: 'a full local computer while both remote catalogs stall', localLoad: 4, fastLoad: null, expected: LOCAL.key },
    { label: 'a free computer before a full one, despite order strategy', localLoad: 4, fastLoad: 1, expected: FAST.key },
    { label: 'the least busy computer when every resolved computer is full', localLoad: 6, fastLoad: 4, expected: FAST.key },
  ].flatMap((c) => [false, true].map((own) => ({ ...c, own }))))('finishes within the quick window with $label (own task=$own)', async ({ localLoad, fastLoad, expected, own }) => {
    vi.useFakeTimers();
    try {
      const { router, config } = quickRouter(localLoad, fastLoad);
      if (own) config.members[0] = { ...LOCAL, paused: true };
      const done = vi.fn();
      void router.pick({
        providerId: 'anthropic', agentKind: 'claude-code', model: MODEL, ...(own ? { localTask: true as const } : {}),
      }).then(done);
      await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS - 1);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        kind: 'member', member: expect.objectContaining({ key: expected }),
      }));
      expect(done.mock.calls[0][0].resolved.find((resolved: ResolvedProviderGroupMember) => resolved.member.key === SLOW.key))
        .toMatchObject({ state: 'offline', pending: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['paused', 'excluded', 'cooling', 'wrong-model'] as const)(
    'keeps waiting when the full resolved computer is %s', async (reason) => {
      vi.useFakeTimers();
      try {
        const { router, config } = quickRouter(4, null);
        if (reason === 'paused') config.members[0] = { ...LOCAL, paused: true };
        if (reason === 'cooling') router.markCooling('anthropic', LOCAL.key, 100_000);
        const done = vi.fn();
        void router.pick({
          providerId: 'anthropic', agentKind: 'claude-code', model: reason === 'wrong-model' ? 'missing-model' : MODEL,
          ...(reason === 'excluded' ? { exclude: new Set([LOCAL.key]) } : {}),
        }).then(done);
        await vi.advanceTimersByTimeAsync(PROVIDER_GROUP_PICK_QUICK_MS * 2);
        expect(done).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
