// @vitest-environment jsdom
/**
 * 供应商组里展开一台电脑看它账号的剩余额度(provider-groups.md §10，2026-10-10 用户要求)：
 *   - 本机读本机账号；我的其他电脑按那台目录里的供应商读那台的账号；
 *   - 别人分享来的电脑、不在线的电脑不去读，直接说明；
 *   - 不是订阅类的供应商说明没有额度；一直读不到时不永远停在「正在读取」。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { UsageCardAccount } from '@/components/status/usageCardModel';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const mocks = vi.hoisted(() => ({
  local: [] as unknown[],
  byDevice: {} as Record<string, unknown[]>,
  deviceReads: [] as Array<string | undefined>,
  cardReads: [] as Array<[string | undefined, string | null]>,
  cards: {} as Record<string, { title: string }>,
  devices: [] as Array<{ deviceId: string; online: boolean; remoteControlEnabled: boolean; controlEnabled: boolean }> | null,
  directoryStatus: 'ready' as 'ready' | 'loading' | 'error',
  presence: new Set<(snapshot: DeviceLinkPresenceSnapshot) => void>(),
  control: new Set<(snapshot: { deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }) => void>(),
  status: new Set<(snapshot: { status: string }) => void>(),
  getState: vi.fn(),
  realCard: false,
  catalogState: 'ready' as 'ready' | 'loading' | 'error',
}));

vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: mocks.local }) }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => mocks.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: mocks.directoryStatus, error: mocks.directoryStatus === 'error' ? 'offline' : null }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: (deviceId?: string) => {
    mocks.deviceReads.push(deviceId);
    return { providers: deviceId && mocks.catalogState === 'ready' ? (mocks.byDevice[deviceId] ?? []) : [],
      loading: !!deviceId && mocks.catalogState === 'loading',
      error: deviceId && mocks.catalogState === 'error' ? 'catalog unavailable' : null, unsupported: false };
  },
}));
vi.mock('@/components/settings/useProviderSubscriptionCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/settings/useProviderSubscriptionCard')>();
  return { ...actual, useDeviceProviderSubscriptionCard: (...args: Parameters<typeof actual.useDeviceProviderSubscriptionCard>) => {
    if (mocks.realCard) return actual.useDeviceProviderSubscriptionCard(...args);
    const [provider, deviceId] = args;
    mocks.cardReads.push([provider?.id, deviceId]);
    return provider ? (mocks.cards[`${deviceId ?? 'local'}:${provider.id}`] ?? null) : null;
  } };
});
vi.mock('@/components/status/QuotaHoverCard', () => ({
  QuotaHoverCard: ({ account, hideIdentity }: { account: UsageCardAccount; hideIdentity?: boolean }) => (
    <div data-testid="quota-card" data-hide-identity={String(Boolean(hideIdentity))}
      data-usage={JSON.stringify(account.windows?.map(window => window.window.utilization))}
      data-notices={JSON.stringify(account.notices)}>
      {account.title}
    </div>
  ),
}));

import { GroupMemberQuota, groupMemberQuotaTarget, type GroupMemberQuotaTarget } from '../GroupMemberQuota';

const claude = (id: string) => ({ id, name: 'Anthropic', source: 'builtin', connected: true, auth: { method: 'oauth', native: 'claude' } });
const apiKey = (id: string) => ({ id, name: 'OpenRouter', source: 'user', connected: true, auth: { method: 'api-key' } });

async function mountQuota(view: ReactElement) {
  const mounted = render(view);
  await act(async () => {});
  return mounted;
}

async function show(target: GroupMemberQuotaTarget, offline = false) {
  return mountQuota(<GroupMemberQuota id="quota" target={target} offline={offline} />);
}

beforeEach(() => {
  mocks.realCard = false;
  mocks.catalogState = 'ready';
  setDataOwnerGeneration('quota-owner');
  mocks.presence.clear();
  mocks.status.clear();
  mocks.control.clear();
  mocks.getState.mockReset().mockResolvedValue({ linkStatus: 'online' });
  vi.stubGlobal('electronAPI', { deviceLink: {
    getState: mocks.getState,
    onControlTargetChanged: (listener: (snapshot: { deviceId: string; enabled: boolean; disabledControlDeviceIds: string[] }) => void) => {
      mocks.control.add(listener);
      return () => mocks.control.delete(listener);
    },
    onPresenceChanged: (listener: (snapshot: DeviceLinkPresenceSnapshot) => void) => {
      mocks.presence.add(listener);
      return () => mocks.presence.delete(listener);
    },
    onStatusChanged: (listener: (snapshot: { status: string }) => void) => {
      mocks.status.add(listener);
      return () => mocks.status.delete(listener);
    },
  } });
  mocks.directoryStatus = 'ready';
  mocks.devices = ['mini', 'pc'].map(deviceId => ({ deviceId, online: true, remoteControlEnabled: true, controlEnabled: true }));
  mocks.local = [claude('anthropic')];
  mocks.byDevice = { mini: [claude('anthropic-1a2b')], pc: [apiKey('openrouter')] };
  mocks.deviceReads.length = 0;
  mocks.cardReads.length = 0;
  mocks.cards = { 'local:anthropic': { title: 'This computer’s Claude' }, 'mini:anthropic-1a2b': { title: 'Mini’s Claude' } };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GroupMemberQuota', () => {
  // Unit r4422287440 / §10: the old group tests replaced the card hook, so
  // they missed its pending Kimi identity being destroyed by a new offline poll.
  // Real group/card/account hooks must retain the first result and queue one
  // reread on member recovery; explicit control revocation must still cancel it.
  it.each(['presence', 'directory', 'catalog', 'revocation'] as const)('retains pending Kimi quota through group recovery via %s', async recovery => {
    vi.useFakeTimers();
    mocks.realCard = true;
    mocks.getState.mockResolvedValue({ linkStatus: 'online', disabledControlDeviceIds: [] });
    mocks.byDevice.mini = [{ ...apiKey('kimi-code'), auth: { method: 'apiKey' },
      routing: { codex: { upstream: 'https://api.kimi.com/coding/v1' } } }];
    const value = (usedPercent: number) => ({ status: 'ready', stale: false, snapshot: {
      kind: 'kimi-coding-quota', fetchedAt: Date.now(), windows: [{ id: 'limit_7d', usedPercent, resetsAt: null }],
    } });
    let finish!: (result: ReturnType<typeof value>) => void;
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValue(new Error('recovery reread failed'));
    Object.assign(window.electronAPI.deviceLink, { invoke });
    let offline = false;
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'kimi-code' }} offline={offline} />;
    const mounted = await mountQuota(view());
    expect(invoke).toHaveBeenCalledTimes(1);
    offline = true;
    mocks.directoryStatus = 'error';
    mounted.rerender(view());
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.deviceReads.at(-1)).toBeUndefined();
    await act(async () => vi.advanceTimersByTime(45_000));
    expect(invoke).toHaveBeenCalledTimes(1);
    if (recovery === 'catalog') mocks.catalogState = 'loading';
    if (recovery === 'revocation') act(() => mocks.control.forEach(listener => listener({
      deviceId: 'mini', enabled: false, disabledControlDeviceIds: ['mini'],
    })));
    if (recovery === 'directory') {
      mocks.directoryStatus = 'ready';
      mocks.devices = [...mocks.devices!];
      mounted.rerender(view());
    } else act(() => mocks.presence.forEach(listener => listener({
      deviceId: 'mini', online: true, remoteControlEnabled: true,
    } as DeviceLinkPresenceSnapshot)));
    expect(invoke).toHaveBeenCalledTimes(1);
    if (recovery === 'catalog') {
      mocks.catalogState = 'error';
      mounted.rerender(view());
      await act(async () => finish(value(38)));
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(invoke).toHaveBeenCalledTimes(1);
      mocks.catalogState = 'ready';
      mounted.rerender(view());
      await act(async () => {});
    } else {
      await act(async () => finish(value(38)));
    }
    if (recovery === 'revocation') {
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('quota-card')).toBeNull();
      invoke.mockResolvedValue(value(76));
      await act(async () => mocks.control.forEach(listener => listener({
        deviceId: 'mini', enabled: true, disabledControlDeviceIds: [],
      })));
      expect(invoke).toHaveBeenCalledTimes(2);
    } else {
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('quota-card').getAttribute('data-usage')).toBe('[38]');
      expect(screen.getByTestId('quota-card').getAttribute('data-notices')).toContain('providerAccountUsage.kimi.stale');
      invoke.mockResolvedValue(value(76));
      await act(async () => vi.advanceTimersByTime(15_000));
      expect(invoke).toHaveBeenCalledTimes(3);
    }
    expect(screen.getByTestId('quota-card').getAttribute('data-usage')).toBe('[76]');
    expect(invoke.mock.calls.every(call => call[0] === 'mini' && call[1] === 'maker:usage:kimi-coding')).toBe(true);
  });

  // Unit r4389934292: the row was collapsed during reconnect, so no local
  // status history exists. An initial online seed + retained loading/error
  // directory must wait for a new target presence or authoritative list.
  it.each([
    { status: 'error', recovery: 'presence' },
    { status: 'loading', recovery: 'directory' },
  ] as const)('fences an initial online seed with a $status directory until $recovery', async ({ status, recovery }) => {
    // Peer recovery is separate from local control; the current host seed grants it.
    mocks.getState.mockResolvedValue({ linkStatus: 'online', disabledControlDeviceIds: [] });
    mocks.directoryStatus = status;
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    const unread = () => {
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    unread();
    const emit = (deviceId: string) => act(() => mocks.presence.forEach(listener => listener({
      deviceId, online: true, remoteControlEnabled: true,
      deviceName: 'Mini', platform: 'darwin', appVersion: 'test', lastSeenAt: 1, busy: false,
    })));
    emit('other');
    unread();
    if (recovery === 'presence') emit('mini');
    else {
      mocks.directoryStatus = 'ready';
      mocks.devices = [...mocks.devices!];
      mounted.rerender(view());
    }
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit r4389675729 / §10: relay recovery is not target recovery. Old tests
  // only blocked while connecting/stopped, then trusted a retained online row.
  // The new generation needs either target presence or a successful new list.
  it.each(['presence', 'directory'] as const)('waits for fresh peer %s after relay recovery', async (recovery) => {
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status: 'connecting' })));
    // A directory loaded while relay was still connecting is also too old.
    mocks.devices = [...mocks.devices!];
    mounted.rerender(view());
    mocks.directoryStatus = 'error';
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    const unread = () => {
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    unread();
    const emit = (deviceId: string) => act(() => mocks.presence.forEach(listener => listener({
      deviceId, online: true, remoteControlEnabled: true,
      deviceName: 'Mini', platform: 'darwin', appVersion: 'test', lastSeenAt: 1, busy: false,
    })));
    emit('other');
    unread();
    if (recovery === 'presence') emit('mini');
    else {
      mocks.directoryStatus = 'ready';
      mocks.devices = [...mocks.devices!];
      mounted.rerender(view());
    }
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    // Once validated in this generation, a later directory failure retains it.
    mocks.directoryStatus = 'error';
    mounted.rerender(view());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit r4389675738: directory=false can remain cached after local enable.
  // A valid full local preference snapshot is authoritative in both directions;
  // an older preload that supplies no list still uses the directory fallback.
  it.each(['push', 'seed'] as const)('restores quota from the current local control %s despite a stale disabled row', async (source) => {
    mocks.devices = [{ deviceId: 'mini', online: true, remoteControlEnabled: true, controlEnabled: false }];
    mocks.directoryStatus = 'error';
    if (source === 'seed') mocks.getState.mockResolvedValue({ linkStatus: 'online', disabledControlDeviceIds: ['other'] });
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    // Keep control recovery isolated from the initial-directory liveness gate.
    act(() => mocks.presence.forEach(listener => listener({ deviceId: 'mini', online: true, remoteControlEnabled: true } as DeviceLinkPresenceSnapshot)));
    if (source === 'push') {
      expect(screen.queryByTestId('quota-card')).toBeNull();
      act(() => mocks.control.forEach(listener => listener({ deviceId: 'mini', enabled: true, disabledControlDeviceIds: ['other'] })));
    }
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    expect(mocks.cardReads.at(-1)).toEqual(['anthropic-1a2b', 'mini']);
    act(() => mocks.control.forEach(listener => listener({ deviceId: 'mini', enabled: false, disabledControlDeviceIds: ['mini', 'other'] })));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
  });

  // Unit r4389410005: an already-open online row missed local opt-out because
  // listDevices failed and no presence announced the control preference change.
  // Retain that local event across failed/new directory snapshots; online
  // presence cannot grant control. Another device's preference is irrelevant.
  it('stops reads on local control revocation even when the directory refresh fails', async () => {
    let finishSeed!: (state: { linkStatus: string; disabledControlDeviceIds: string[] }) => void;
    mocks.getState.mockReturnValue(new Promise(resolve => { finishSeed = resolve; }));
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    const control = (deviceId: string, enabled: boolean, disabledControlDeviceIds: string[]) => act(() => {
      mocks.control.forEach(listener => listener({ deviceId, enabled, disabledControlDeviceIds }));
    });
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    control('other', false, ['other']);
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mocks.directoryStatus = 'loading';
    control('mini', false, ['mini', 'other']);
    const unread = () => {
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    unread();
    // A seed started before the revocation must not restore its old grant.
    await act(async () => finishSeed({ linkStatus: 'online', disabledControlDeviceIds: [] }));
    unread();
    mocks.directoryStatus = 'error';
    mounted.rerender(view());
    act(() => mocks.presence.forEach(listener => listener({ deviceId: 'mini', online: true, remoteControlEnabled: true } as DeviceLinkPresenceSnapshot)));
    unread();
    mocks.devices = [...mocks.devices!];
    mocks.directoryStatus = 'ready';
    mounted.rerender(view());
    unread();
    control('mini', true, ['other']);
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mounted.unmount();
    expect(mocks.control.size).toBe(0);
  });

  // Unit r4421585007 / §10: revocation happened while collapsed. Existing
  // control tests observed that event; a failed seed and failed directory leave
  // no current local grant, even after relay and remote presence recover.
  it.each(['push', 'directory'] as const)('requires current control evidence after a failed seed until %s recovery', async recovery => {
    mocks.getState.mockRejectedValue(new Error('state unavailable'));
    mocks.directoryStatus = 'error';
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    act(() => mocks.presence.forEach(listener => listener({
      deviceId: 'mini', online: true, remoteControlEnabled: true,
    } as DeviceLinkPresenceSnapshot)));
    const unread = () => {
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    unread();
    if (recovery === 'push') {
      act(() => mocks.control.forEach(listener => listener({ deviceId: 'mini', enabled: false, disabledControlDeviceIds: ['mini'] })));
      unread();
      act(() => mocks.control.forEach(listener => listener({ deviceId: 'mini', enabled: true, disabledControlDeviceIds: [] })));
    } else {
      mocks.directoryStatus = 'ready';
      mocks.devices = mocks.devices!.map(row => ({ ...row, controlEnabled: false }));
      mounted.rerender(view());
      unread();
      mocks.devices = mocks.devices!.map(row => ({ ...row, controlEnabled: true }));
      mounted.rerender(view());
    }
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit r4390515501 / §10: a ready directory already proved this target
  // online, but the group's stale offline flag won again on an unrelated list
  // refresh. Existing loading/error tests only covered unconfirmed old arrays.
  it.each(['initial', 'recovered'] as const)('retains the %s ready target across unrelated directory refreshes', async phase => {
    if (phase === 'recovered') mocks.devices = mocks.devices!.map(row => ({ ...row, online: row.deviceId !== 'mini' }));
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />;
    const mounted = await mountQuota(view());
    const unread = () => {
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    const readable = () => {
      expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
      expect(mocks.deviceReads.at(-1)).toBe('mini');
      expect(mocks.cardReads.at(-1)).toEqual(['anthropic-1a2b', 'mini']);
    };
    if (phase === 'recovered') {
      unread();
      mocks.devices = mocks.devices!.map(row => ({ ...row, online: true }));
      mounted.rerender(view());
    }
    readable();
    for (const status of ['loading', 'error'] as const) {
      mocks.directoryStatus = status;
      mounted.rerender(view());
      readable();
    }
    // Even a changed array caused by another device is not target evidence.
    mocks.devices = mocks.devices!.map(row => row.deviceId === 'mini' ? row : { ...row, online: false });
    mounted.rerender(view());
    readable();
    const emit = (online: boolean) => act(() => mocks.presence.forEach(listener => listener({
      deviceId: 'mini', online, remoteControlEnabled: true,
      deviceName: 'Mini', platform: 'darwin', appVersion: 'test', lastSeenAt: 1, busy: false,
    })));
    emit(false);
    unread();
    mocks.devices = [...mocks.devices!];
    mounted.rerender(view());
    unread(); // A retained old online row cannot undo explicit target offline.
    mocks.directoryStatus = 'ready';
    mocks.devices = [...mocks.devices!];
    mounted.rerender(view());
    readable();
    mocks.directoryStatus = 'error';
    mounted.rerender(view());
    act(() => mocks.control.forEach(listener => listener({ deviceId: 'mini', enabled: false, disabledControlDeviceIds: ['mini'] })));
    unread();
    act(() => mocks.control.forEach(listener => listener({ deviceId: 'mini', enabled: true, disabledControlDeviceIds: [] })));
    readable(); // Re-enabling local control retains the confirmed peer liveness.
    act(() => mocks.status.forEach(listener => listener({ status: 'connecting' })));
    unread();
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    unread(); // Confirmation belongs to the prior relay generation.
    emit(true);
    readable();
  });

  // Unit r4391647927 / r4391955018 / §10: earlier cases kept offline=true throughout.
  // A later group poll can report a new offline transition after directory
  // confirmation (and even online presence), while listDevices retains old rows.
  it.each([
    { status: 'loading', recovery: 'directory' },
    { status: 'error', recovery: 'presence' },
    { status: 'ready', recovery: 'directory' },
    { status: 'ready', recovery: 'presence' },
  ] as const)('invalidates older peer evidence on a new offline group state during $status', async ({ status, recovery }) => {
    let offline = false;
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={offline} />;
    const mounted = await mountQuota(view());
    const readable = () => expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    const unread = () => {
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    const emit = (deviceId: string) => act(() => mocks.presence.forEach(listener => listener({
      deviceId, online: true, remoteControlEnabled: true,
      deviceName: 'Mini', platform: 'darwin', appVersion: 'test', lastSeenAt: 1, busy: false,
    })));
    readable();
    if (recovery === 'presence') emit('mini');
    mocks.directoryStatus = status;
    mounted.rerender(view());
    readable(); // A directory refresh alone does not invalidate confirmed state.
    mocks.deviceReads.length = 0;
    mocks.cardReads.length = 0;
    offline = true;
    mounted.rerender(view());
    unread();
    expect(mocks.deviceReads.every(id => id === undefined)).toBe(true);
    expect(mocks.cardReads.every(([provider, id]) => provider === undefined && id === null)).toBe(true);
    emit('other');
    mounted.rerender(view());
    unread();
    if (recovery === 'presence') emit('mini');
    else {
      mocks.directoryStatus = 'ready';
      mocks.devices = [...mocks.devices!];
      mounted.rerender(view());
    }
    readable();
    // Another online→offline transition must also discard the recovered evidence.
    offline = false;
    mocks.directoryStatus = 'error';
    mounted.rerender(view());
    readable();
    offline = true;
    mounted.rerender(view());
    unread();
  });

  // Unit r4389193553 / §10: the old offline-directory test missed a stale
  // online array retained after a missed pre-mount offline event + failed read.
  // Error/loading cannot override the group's offline row without fresh target
  // presence; neither a cached provider nor an unrelated peer can enable reads.
  it.each(['error', 'loading'] as const)('keeps a stale-online directory unread while its request is %s', async (status) => {
    // This case tests stale peer liveness with a current local control snapshot.
    mocks.getState.mockResolvedValue({ linkStatus: 'online', disabledControlDeviceIds: [] });
    mocks.directoryStatus = status;
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />;
    const mounted = await mountQuota(view());
    const unread = () => {
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    unread();
    const emit = (deviceId: string, online: boolean) => act(() => mocks.presence.forEach(listener => listener({
      deviceId, online, remoteControlEnabled: true,
      deviceName: 'Mini', platform: 'darwin', appVersion: 'test', lastSeenAt: 1, busy: false,
    })));
    emit('other', true);
    unread();
    emit('mini', true);
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    emit('mini', false);
    unread();
    // A fresh authoritative directory can recover independently of group cache.
    mocks.directoryStatus = 'ready';
    mocks.devices = [...mocks.devices!];
    mounted.rerender(view());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit regression r4388475435 / provider-groups.md §10: the old tests
  // supplied permissions only after recovery. A cached online group + online
  // relay must not show quota or read a peer without a matching directory row,
  // including after that row disappears; an online push cannot grant control.
  it('requires directory permissions before reading and clears quota when the target row disappears', async () => {
    mocks.devices = null;
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    const unread = () => {
      expect(screen.queryByTestId('quota-card')).toBeNull();
      expect(mocks.deviceReads.at(-1)).toBeUndefined();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    };
    unread();
    const online = { deviceId: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true };
    const emitOnline = () => act(() => mocks.presence.forEach(listener => listener({
      deviceId: 'mini', online: true, remoteControlEnabled: true,
      deviceName: 'Mini', platform: 'darwin', appVersion: 'test', lastSeenAt: 1, busy: false,
    })));
    for (const directory of [[], [{ ...online, deviceId: 'other' }]]) {
      mocks.devices = directory;
      mounted.rerender(view());
      emitOnline();
      unread();
    }
    mocks.devices = [online];
    mounted.rerender(view());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    for (const directory of [null, []]) {
      mocks.devices = directory;
      mounted.rerender(view());
      emitOnline();
      unread();
    }
    mocks.devices = [{ ...online, controlEnabled: false }];
    mounted.rerender(view());
    emitOnline();
    unread();
    mocks.devices = [online];
    mounted.rerender(view());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit regression r4356429402: opening a stale-online row after the stopped
  // event must wait for the real initial state. Existing coverage only sent
  // future status events after mounting; initial failure must not permit reads.
  it.each(['stopped', 'unavailable'] as const)('waits for the initial relay state and keeps %s targets unread', async (state) => {
    vi.useFakeTimers();
    let resolve!: (state: { linkStatus: string }) => void;
    let reject!: (error: Error) => void;
    mocks.getState.mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail; }));
    const mounted = await mountQuota(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />);
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.deviceReads.every(deviceId => deviceId === undefined)).toBe(true);
    expect(mocks.cardReads.every(([providerId, deviceId]) => providerId === undefined && deviceId === null)).toBe(true);
    await act(async () => {
      if (state === 'stopped') resolve({ linkStatus: 'stopped' });
      else reject(new Error('state temporarily unavailable'));
    });
    if (state === 'unavailable') act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByText(state === 'stopped' ? 'providerGroup.member.quota.offline' : 'providerGroup.member.quota.unavailable')).toBeTruthy();
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    if (state === 'stopped') {
      expect(screen.queryByTestId('quota-card')).toBeNull();
      act(() => mocks.presence.forEach(listener => listener({ deviceId: 'mini', online: true, remoteControlEnabled: true } as DeviceLinkPresenceSnapshot)));
    }
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mounted.unmount();
  });

  // A state read launched before a newer status push cannot reverse that push.
  it.each([
    ['stopped', 'online', false],
    ['online', 'stopped', true],
  ] as const)('keeps the newer %s push when an older %s seed arrives', async (push, seed, readable) => {
    let resolve!: (state: { linkStatus: string }) => void;
    mocks.getState.mockReturnValue(new Promise(done => { resolve = done; }));
    await mountQuota(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />);
    expect(screen.queryByTestId('quota-card')).toBeNull();
    act(() => mocks.status.forEach(listener => listener({ status: push })));
    await act(async () => resolve({ linkStatus: seed }));
    expect(Boolean(screen.queryByTestId('quota-card'))).toBe(readable);
    if (!readable) expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
  });

  it('discards an initial relay reply from the previous owner', async () => {
    const replies: Array<(state: { linkStatus: string }) => void> = [];
    mocks.getState.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(view());
    setDataOwnerGeneration('next-owner');
    await act(async () => mounted.rerender(view()));
    await act(async () => replies[0]({ linkStatus: 'online' }));
    expect(screen.queryByTestId('quota-card')).toBeNull();
    await act(async () => replies[1]({ linkStatus: 'stopped' }));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    expect(screen.queryByTestId('quota-card')).toBeNull();
    mocks.devices = [...mocks.devices!];
    mounted.rerender(view());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
  });

  // Unit regression r4356185973 / provider-groups.md §10: a stopped relay
  // must disable a previously online member even before the directory clears,
  // and keep it disabled after null replaces the directory. Existing stop
  // coverage used an already-offline directory and offline=true group state.
  // r4389409994 also covers connecting: a retained online directory cannot
  // authorize invoke while relay reconnects. The local card remains usable.
  it.each(['stopped', 'connecting'] as const)('stops remote quota reads when relay is %s despite stale online group and directory snapshots', async (status) => {
    const online = [{ deviceId: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true }];
    mocks.devices = online;
    const remote = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />;
    const mounted = await mountQuota(remote());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status })));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    expect(mocks.deviceReads.at(-1)).toBeUndefined();
    for (const directory of [null, [...online]]) {
      mocks.devices = directory;
      mounted.rerender(remote());
      act(() => mocks.presence.forEach(listener => listener({ deviceId: 'mini', online: true, remoteControlEnabled: true } as DeviceLinkPresenceSnapshot)));
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    }
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'local', providerId: 'anthropic' }} offline={false} />);
    expect(screen.getByTestId('quota-card').textContent).toBe('This computer’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    // Recovery needs a new directory from the now-online relay generation.
    mocks.devices = [...online];
    mounted.rerender(remote());
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mounted.unmount();
    expect(mocks.status.size).toBe(0);
    expect(mocks.presence.size).toBe(0);
  });

  // Unit regression r4355497190: listDevices retains its old offline array on
  // failure. Existing recovery only replaced that array. A target online push
  // must show its quota immediately, while another peer, disabled controls,
  // stopped relay and a different owner cannot enable the read.
  it('recovers from target presence while the device directory remains stale after a failed refresh', async () => {
    const device = { deviceId: 'mini', online: false, remoteControlEnabled: true, controlEnabled: true };
    mocks.devices = [device];
    const view = () => <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />;
    const mounted = await mountQuota(view());
    const emit = (deviceId: string, remoteControlEnabled = true) => act(() => {
      const snapshot = { deviceId, online: true, remoteControlEnabled } as DeviceLinkPresenceSnapshot;
      mocks.presence.forEach(listener => listener(snapshot));
    });
    emit('other');
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini', false);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    expect(mocks.devices).toEqual([device]);
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'other', providerId: 'anthropic-1a2b' }} offline />);
    mounted.rerender(view());
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    mocks.devices = [{ ...device, controlEnabled: false }];
    mounted.rerender(view());
    emit('mini');
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    mocks.devices = [device];
    mounted.rerender(view());
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    act(() => mocks.status.forEach(listener => listener({ status: 'stopped' })));
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    emit('mini');
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    act(() => mocks.status.forEach(listener => listener({ status: 'online' })));
    emit('mini');
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    setDataOwnerGeneration('another-owner');
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    mounted.unmount();
    expect(mocks.presence.size).toBe(0);
    expect(mocks.status.size).toBe(0);
  });

  // Unit regression: PR #6752 review r4344705878. The existing offline test only
  // checks that quota reads stop, not recovery from a stale offline group view.
  // Public component must read the target as soon as the shared device list says
  // it is online, even while the group still has a cached offline status.
  it('recovers quota reads from live device presence without waiting for the cached group status', async () => {
    vi.useFakeTimers();
    mocks.devices = [];
    const view = <GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />;
    const mounted = await mountQuota(view);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.deviceReads.every(deviceId => deviceId === undefined)).toBe(true);
    mocks.devices = [{ deviceId: 'mini', online: true, remoteControlEnabled: true, controlEnabled: true }];
    mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline />);
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    // Losing connectivity/permission must stop reads even if the group still
    // reports online. An online presence alone cannot override either switch.
    for (const unavailable of [
      { online: false, remoteControlEnabled: true, controlEnabled: true },
      { online: true, remoteControlEnabled: false, controlEnabled: true },
      { online: true, remoteControlEnabled: true, controlEnabled: false },
    ]) {
      mocks.devices = [{ deviceId: 'mini', ...unavailable }];
      mounted.rerender(<GroupMemberQuota id="quota" target={{ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }} offline={false} />);
      expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
      expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    }
  });

  it('reads this computer’s account for this computer', async () => {
    await show({ kind: 'local', providerId: 'anthropic' });
    expect(screen.getByTestId('quota-card').textContent).toBe('This computer’s Claude');
    // 行本身已说明是哪台电脑：卡片不再出标题行。
    expect(screen.getByTestId('quota-card').getAttribute('data-hide-identity')).toBe('true');
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
  });

  // Unit r4391443314 / §10: a remote owner's cached offline status can
  // describe this viewing computer. Existing local coverage only used offline=false.
  // Resolve the actual member mapping, then render quota without any usable peer
  // directory: local data must recover immediately and never query the group owner.
  it('reads a self member locally despite the remote owner’s stale offline state', async () => {
    const target = groupMemberQuotaTarget({ kind: 'device', agentDeviceId: 'this-computer', providerId: 'anthropic' }, 'group-owner', 'this-computer');
    expect(target).toEqual({ kind: 'local', providerId: 'anthropic' });
    mocks.devices = null;
    mocks.directoryStatus = 'error';
    const view = () => <GroupMemberQuota id="quota" target={target} offline />;
    const mounted = await mountQuota(view());
    const readable = () => {
      expect(screen.getByTestId('quota-card').textContent).toBe('This computer’s Claude');
      expect(mocks.cardReads.at(-1)).toEqual(['anthropic', null]);
      expect(mocks.deviceReads.every(id => id === undefined)).toBe(true);
    };
    readable();
    for (const status of ['connecting', 'stopped', 'online']) {
      act(() => mocks.status.forEach(listener => listener({ status })));
      readable(); // Relay availability does not gate this computer's own data.
    }
    expect(mocks.getState).not.toHaveBeenCalled();
    mocks.local = [claude('another-account')];
    mounted.rerender(view());
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.cardReads.at(-1)).toEqual([undefined, null]);
    mocks.local = [claude('anthropic')];
    mounted.rerender(view());
    readable(); // Local account recovery does not wait for the owner's next poll.
  });

  it('reads my other computer’s own account through its directory', async () => {
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    expect(screen.getByTestId('quota-card').textContent).toBe('Mini’s Claude');
    expect(mocks.cardReads.at(-1)).toEqual(['anthropic-1a2b', 'mini']);
  });

  it('does not read a computer shared by someone else', async () => {
    await show({ kind: 'share' });
    expect(screen.getByText('providerGroup.member.quota.share')).toBeTruthy();
    expect(screen.queryByTestId('quota-card')).toBeNull();
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
    expect(mocks.cardReads.every(([providerId]) => providerId === undefined)).toBe(true);
  });

  it('does not read an offline computer', async () => {
    mocks.devices = [{ deviceId: 'mini', online: false, remoteControlEnabled: true, controlEnabled: true }];
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' }, true);
    expect(screen.getByText('providerGroup.member.quota.offline')).toBeTruthy();
    expect(mocks.deviceReads.every((deviceId) => deviceId === undefined)).toBe(true);
  });

  it('says a provider without a subscription quota has none', async () => {
    await show({ kind: 'device', deviceId: 'pc', providerId: 'openrouter' });
    expect(screen.getByText('providerGroup.member.quota.none')).toBeTruthy();
  });

  it('stops saying it is reading when the quota never arrives', async () => {
    vi.useFakeTimers();
    mocks.cards = {};
    await show({ kind: 'device', deviceId: 'mini', providerId: 'anthropic-1a2b' });
    expect(screen.getByText('providerGroup.member.quota.loading')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByText('providerGroup.member.quota.unavailable')).toBeTruthy();
  });
});

describe('groupMemberQuotaTarget', () => {
  const member = (kind: 'local' | 'device' | 'share', agentDeviceId: string | null, providerId = 'p') => ({ kind, agentDeviceId, providerId });

  it('reads the group computer for its own entry and this computer for itself', () => {
    // 本机的组。
    expect(groupMemberQuotaTarget(member('local', null), null, 'self')).toEqual({ kind: 'local', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('device', 'mini'), null, 'self')).toEqual({ kind: 'device', deviceId: 'mini', providerId: 'p' });
    // 另一台电脑(studio)上的组：组所在电脑自己读 studio，组员就是本机时读本机。
    expect(groupMemberQuotaTarget(member('local', null), 'studio', 'self')).toEqual({ kind: 'device', deviceId: 'studio', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('device', 'self'), 'studio', 'self')).toEqual({ kind: 'local', providerId: 'p' });
    expect(groupMemberQuotaTarget(member('share', 'share:s1'), 'studio', 'self')).toEqual({ kind: 'share' });
  });
});
