// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    deviceId: 'self',
    dataOwnerId: 'test-owner',
  }),
}));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  getInterestedDeviceCapabilityTargets: () => [],
  prefetchDeviceCapabilities: vi.fn(),
  evictDeviceCapabilities: vi.fn(),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  getInterestedDeviceProviderTargets: () => [],
  prefetchDeviceProviders: vi.fn(),
  evictDeviceProviders: vi.fn(() => 1),
  isDeviceProvidersGenerationCurrent: vi.fn(() => true),
}));
vi.mock('@/hooks/useGitSafetySettings', () => ({
  prefetchDeviceGitSafetySettings: vi.fn(),
  evictDeviceGitSafetySettings: vi.fn(),
}));
vi.mock('@/features/device-link/mirrorCacheClient', () => ({
  cancelSessionListPersist: vi.fn(),
  clearCachedDevice: vi.fn(),
  clearMirrorCacheAccountState: vi.fn(),
  readCachedSessionList: vi.fn(async () => []),
  scheduleSessionListPersist: vi.fn(),
  sessionListOwnerTokensReady: () => true,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { prefetchDeviceProviders, evictDeviceProviders } from '@/hooks/useDeviceProviders';
import { prefetchDeviceCapabilities } from '@/hooks/useAgentCapabilities';
import { prefetchDeviceGitSafetySettings } from '@/hooks/useGitSafetySettings';
import { readCachedSessionList } from '@/features/device-link/mirrorCacheClient';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

/** Real hook/store/refresh orchestration with independent controllable peer transports. */
const peers = ['slow', 'healthy'].map((deviceId) => ({
  deviceId,
  name: deviceId,
  online: true,
  remoteControlEnabled: true,
  isSelf: false,
}));
type Listener = (event: any) => void;
let listeners: Record<string, Listener>;
const subscribe = vi.fn();
const invoke = vi.fn();
const getState = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
const control = (enabled: boolean) =>
  listeners.onControlTargetChanged({
    deviceId: 'slow',
    enabled,
    disabledControlDeviceIds: enabled ? [] : ['slow'],
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(prefetchDeviceGitSafetySettings).mockReset();
  listeners = {};
  subscribe.mockReset().mockResolvedValue({});
  invoke
    .mockReset()
    .mockImplementation(async (_peer, channel) =>
      channel === 'maker:schedule:list-sidebar-index-runs' ? { runs: [] } : [],
    );
  getState.mockReset().mockResolvedValue({ linkStatus: 'online', disabledControlDeviceIds: [] });
  const events = Object.fromEntries(
    [
      'onResponsivenessChanged',
      'onPresenceChanged',
      'onRemotePush',
      'onStatusChanged',
      'onAccessRevoked',
      'onControlTargetChanged',
      'onPeerLinkReset',
      'onPeerLinkReopened',
      'onDeviceDirectoryInvalidated',
    ].map((name) => [
      name,
      (listener: Listener) => {
        listeners[name] = listener;
        return () => {};
      },
    ]),
  );
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      deviceLink: {
        ...events,
        subscribe,
        invoke,
        getState,
        unsubscribe: vi.fn(async () => {}),
        listDevices: vi.fn(async () => ({ devices: peers })),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  remoteProjectsStore.clear();
  vi.useRealTimers();
});

describe('multi-device recovery lifecycle', () => {
  // Unit regression: Main fences all three source-change events, but the renderer
  // only refreshed providers on one of them, leaving failed in-flight reads stuck.
  // Exercise the real push listener and refresh coordinator; transport reads are mocked.
  it.each(['maker:agents:changed', 'provider-group:changed', 'maker:provider:changed'])(
    'refreshes the affected catalog on %s without reopening a retired target', async (channel) => {
      setDataOwnerGeneration('test-owner', 1);
      onTestFinished(() => setDataOwnerGeneration(null));
      renderHook(() => useDeviceLinkRemoteProjects());
      await settle();
      vi.mocked(prefetchDeviceProviders).mockClear();
      vi.mocked(prefetchDeviceCapabilities).mockClear();
      vi.mocked(evictDeviceProviders).mockClear();
      act(() => listeners.onRemotePush({ deviceId: 'healthy', channel, payload: {} }));
      await settle();
      expect(prefetchDeviceProviders).toHaveBeenCalledExactlyOnceWith('healthy');
      expect(prefetchDeviceCapabilities).toHaveBeenCalledExactlyOnceWith('healthy');

      vi.mocked(prefetchDeviceProviders).mockClear();
      vi.mocked(prefetchDeviceCapabilities).mockClear();
      act(() => listeners.onRemotePush({ deviceId: 'healthy', channel,
        payload: { providerContinuity: { stale: true, remainingMs: 0 } } }));
      await settle();
      expect(evictDeviceProviders).toHaveBeenLastCalledWith('healthy', { retainDisplaySnapshot: false });
      expect(prefetchDeviceProviders).not.toHaveBeenCalled();
      expect(prefetchDeviceCapabilities).not.toHaveBeenCalled();
    },
  );

  it('late catalog completion cannot clear a newer revocation', async () => {
    const old = deferred<void>();
    vi.mocked(prefetchDeviceGitSafetySettings).mockImplementation((peer) =>
      peer === 'slow' ? old.promise : Promise.resolve(),
    );
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(prefetchDeviceGitSafetySettings).toHaveBeenCalledWith('slow');
    act(() => listeners.onAccessRevoked({ deviceId: 'slow' }));
    expect(revokedDevicesStore.has('slow')).toBe(true);
    old.resolve();
    await settle();
    expect(revokedDevicesStore.has('slow')).toBe(true);
    expect(remoteProjectsStore.hasDevice('slow')).toBe(false);
    expect(remoteProjectsStore.hasDevice('healthy')).toBe(true);
  });

  it('slow subscription does not delay a healthy peer, and disable cancels queued bootstrap', async () => {
    const slow = deferred<object>();
    subscribe.mockImplementation((peer: string) =>
      peer === 'slow' ? slow.promise : Promise.resolve({}),
    );
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(remoteProjectsStore.hasDevice('healthy')).toBe(true);
    expect(remoteProjectsStore.hasDevice('slow')).toBe(false);
    act(() =>
      listeners.onResponsivenessChanged({ deviceId: 'slow', unresponsive: false, recovered: true }),
    );
    act(() => control(false));
    slow.resolve({});
    await settle();
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(1);
    expect(invoke.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(0);
    expect(remoteProjectsStore.hasDevice('healthy')).toBe(true);
  });

  it('clearing failure state does not bootstrap, but genuine recovery does', async () => {
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    subscribe.mockClear();
    act(() =>
      listeners.onResponsivenessChanged({
        deviceId: 'slow',
        unresponsive: false,
        recovered: false,
      }),
    );
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
    act(() =>
      listeners.onResponsivenessChanged({ deviceId: 'slow', unresponsive: false, recovered: true }),
    );
    await settle();
    expect(subscribe).toHaveBeenCalledExactlyOnceWith('slow', ['sessions']);
  });

  it('transient sessions subscribe failure is retried by the periodic reconcile', async () => {
    subscribe.mockImplementation((peer: string) =>
      peer === 'slow' && subscribe.mock.calls.filter(([p]) => p === 'slow').length === 1
        ? Promise.reject(new Error('[DEVICE_LINK_BUSY] request expired before socket write'))
        : Promise.resolve({}),
    );
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(1);
    // The list still bootstraps; only live pushes (running activity / island) were missing.
    expect(remoteProjectsStore.hasDevice('slow')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(2);
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'healthy')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(2);
  });

  /** slow 首次 subscribe 报 BUSY,第二次(周期补订)交给返回的 deferred 手动收尾。 */
  async function startPendingResubscribe() {
    const retry = deferred<object>();
    let slowCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    subscribe.mockImplementation((peer: string) => {
      if (peer !== 'slow') return Promise.resolve({});
      slowCalls += 1;
      if (slowCalls === 1) {
        return Promise.reject(new Error('[DEVICE_LINK_BUSY] request expired before socket write'));
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const pending = slowCalls === 2 ? retry.promise : Promise.resolve({});
      return pending.finally(() => {
        inFlight -= 1;
      });
    });
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(2);
    return { retry, maxInFlight: () => maxInFlight };
  }

  it('a late resubscribe revocation cannot remove a device that re-entered', async () => {
    const { retry } = await startPendingResubscribe();
    act(() => control(false));
    act(() => control(true));
    await settle();
    retry.reject(new Error('[DEVICE_LINK_ACCESS_REVOKED] old connection'));
    await settle();
    expect(revokedDevicesStore.has('slow')).toBe(false);
    expect(remoteProjectsStore.hasDevice('slow')).toBe(true);
    // The re-entered lifecycle still runs its own full bootstrap after the stale request.
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(3);
  });

  it('a bootstrap requested during resubscribe waits instead of subscribing concurrently', async () => {
    const { retry, maxInFlight } = await startPendingResubscribe();
    act(() =>
      listeners.onResponsivenessChanged({ deviceId: 'slow', unresponsive: false, recovered: true }),
    );
    await settle();
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(2);
    retry.resolve({});
    await settle();
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(3);
    expect(maxInFlight()).toBe(1);
  });

  it('unsupported sessions subscribe is not retried', async () => {
    subscribe.mockImplementation((peer: string) =>
      peer === 'slow'
        ? Promise.reject(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] old peer'))
        : Promise.resolve({}),
    );
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(1);
  });

  it('late initial settings cannot undo a disable notification', async () => {
    const initial = deferred<object>();
    getState.mockReturnValue(initial.promise);
    renderHook(() => useDeviceLinkRemoteProjects());
    act(() => control(false));
    initial.resolve({ linkStatus: 'online', disabledControlDeviceIds: [] });
    await settle();
    expect(subscribe.mock.calls.map(([peer]) => peer)).toEqual(['healthy']);
  });

  it('disable/re-enable waits for the old subscription and rejects its late revocation', async () => {
    const old = deferred<object>();
    subscribe.mockImplementationOnce(() => old.promise);
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    act(() => control(false));
    act(() => control(true));
    await settle();
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(1);
    old.reject(new Error('[DEVICE_LINK_ACCESS_REVOKED] old connection'));
    await settle();
    expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(2);
    expect(remoteProjectsStore.hasDevice('slow')).toBe(true);
    expect(remoteProjectsStore.hasDevice('healthy')).toBe(true);
  });
  // 2026-11-04: another computer's every-minute PR watchers sent fired + skipped pairs,
  // and each event pulled the whole run index (~100 KB, 872 reads/day). A pair now costs
  // one read after a quiet period, and a steady stream is still read within the max wait.
  it('coalesces a remote schedule event burst into one index read after a quiet period', async () => {
    setDataOwnerGeneration('test-owner', 1);
    onTestFinished(() => setDataOwnerGeneration(null));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const indexReads = () =>
      invoke.mock.calls.filter(([peer, channel]) => peer === 'healthy' && channel === 'maker:schedule:list-sidebar-index-runs');
    invoke.mockClear();
    const event = (type: string, runId: string) =>
      act(() =>
        listeners.onRemotePush({
          deviceId: 'healthy',
          channel: 'maker:schedule:event',
          payload: { type, scheduleId: 's1', runId, sessionId: '' },
        }),
      );
    event('fired', 'r1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    event('skipped', 'r1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(indexReads()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(indexReads()).toHaveLength(1);

    invoke.mockClear();
    for (let i = 0; i < 6; i++) {
      event(i % 2 ? 'skipped' : 'fired', `r${i}`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }
    expect(indexReads()).toHaveLength(1);
  });

  // Same incident: the 60 s safety-net reconcile also re-read every peer's whole run
  // index. Live events keep it current, so the reconcile reads it every 5 minutes, and
  // at once when events were skipped while the window was idle.
  it('re-reads the run index on the periodic reconcile only every 5 minutes or after skipped events', async () => {
    // Read times are module state; earlier tests in this file advanced their own fake clocks.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    setDataOwnerGeneration('test-owner', 1);
    onTestFinished(() => setDataOwnerGeneration(null));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const reads = (channel: string) =>
      invoke.mock.calls.filter(([peer, ch]) => peer === 'healthy' && ch === channel).length;
    const minute = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    };
    invoke.mockClear();
    for (let i = 0; i < 4; i++) await minute();
    expect(reads('local-db:sessions:list')).toBeGreaterThanOrEqual(3);
    expect(reads('maker:schedule:list-sidebar-index-runs')).toBe(0);
    await minute();
    await minute();
    expect(reads('maker:schedule:list-sidebar-index-runs')).toBe(1);

    // Hidden: events are skipped; showing the window again must catch the index up
    // even though the last periodic read was under 5 minutes ago.
    const visibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    onTestFinished(() => visibility('visible'));
    act(() => visibility('hidden'));
    act(() =>
      listeners.onRemotePush({
        deviceId: 'healthy',
        channel: 'maker:schedule:event',
        payload: { type: 'fired', scheduleId: 's1', runId: 'r9' },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    invoke.mockClear();
    act(() => visibility('visible'));
    await settle();
    expect(reads('maker:schedule:list-sidebar-index-runs')).toBe(1);
  });

  // PR #8806 review: a refresh returning ok does not prove the index was read (an index
  // failure inside scope both; a weak tick reusing another refresh), and a read already
  // in flight must not clear events skipped after it started.
  it('counts only successful index reads and keeps events skipped during an in-flight read', async () => {
    vi.setSystemTime(Date.now() + 20 * 60_000);
    setDataOwnerGeneration('test-owner', 1);
    onTestFinished(() => setDataOwnerGeneration(null));
    const visibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    onTestFinished(() => visibility('visible'));
    const missedEvent = (runId: string) =>
      act(() =>
        listeners.onRemotePush({
          deviceId: 'healthy',
          channel: 'maker:schedule:event',
          payload: { type: 'fired', scheduleId: 's1', runId },
        }),
      );
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const indexReads = () =>
      invoke.mock.calls.filter(([peer, ch]) => peer === 'healthy' && ch === 'maker:schedule:list-sidebar-index-runs').length;

    // An index failure during the catch-up keeps the skipped event pending.
    act(() => visibility('hidden'));
    missedEvent('r1');
    invoke.mockImplementation(async (_peer, channel) => {
      if (channel === 'maker:schedule:list-sidebar-index-runs') throw new Error('[DEVICE_LINK_TIMEOUT] index');
      return [];
    });
    invoke.mockClear();
    act(() => visibility('visible'));
    await settle();
    expect(indexReads()).toBe(1);
    const index = deferred<unknown>();
    invoke.mockImplementation(async (_peer, channel) =>
      channel === 'maker:schedule:list-sidebar-index-runs' ? index.promise : []);
    invoke.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(indexReads()).toBe(1);

    // An event skipped while that retry is still in flight survives its success.
    act(() => visibility('hidden'));
    missedEvent('r2');
    index.resolve({ runs: [] });
    await settle();
    invoke.mockImplementation(async (_peer, channel) =>
      channel === 'maker:schedule:list-sidebar-index-runs' ? { runs: [] } : []);
    invoke.mockClear();
    act(() => visibility('visible'));
    await settle();
    expect(indexReads()).toBe(1);
  });
});

/**
 * 测试价值
 * - 生产入口与可观察结果：真实 useDeviceLinkRemoteProjects + remoteProjectsStore + refreshRemoteDeviceSessions；
 *   断言设备分片回到 connected（即任务横幅不再显示「远程设备已离线」、历史视图恢复读取）。
 * - Bug 依据：2026-11-17 电脑合盖睡眠一夜后唤醒，Mac Studio 链路 1–3 秒可达，界面却 40+ 分钟显示离线：
 *   唤醒时目录读取失败退回过期快照（数据通道尚未就绪 → online:false），设备被移出合格集；所有恢复途径
 *   只看合格集，设备一直在线不再来上线通知，周期对账又受「5 分钟内有键鼠操作」限制 → 永久卡住。
 * - 规则：remote-and-mobile-adaptation「设备列表读取失败后的未知不等于离线」「真实恢复不能被旧退避挡住」；
 *   故障半径三问 —— 恢复只作用于该设备，健康设备请求数不变。
 * - 现有覆盖缺口：已有用例只覆盖过期目录缺席设备、订阅繁忙补订，未覆盖过期目录把在线设备报成离线、
 *   设备被移出合格集后的恢复，以及无用户操作时的首拉补齐。
 * - 最小失败输入：connecting → 20s 宽限 → 过期目录 {slow online:false} → online → 数据通道上线。
 * - tier：unit（jsdom，假定时器）。
 */
describe('wake-from-sleep recovery', () => {
  const listDevices = () => window.electronAPI.deviceLink.listDevices as ReturnType<typeof vi.fn>;
  const healthyCalls = () => ({
    subscribe: subscribe.mock.calls.filter(([peer]) => peer === 'healthy').length,
    list: invoke.mock.calls.filter(([peer, channel]) => peer === 'healthy' && channel === 'local-db:sessions:list').length,
  });
  const connected = () => remoteProjectsStore.getDeviceIds();
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('a stale directory reporting a reachable device offline does not strand it after wake', async () => {
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(connected()).toEqual(expect.arrayContaining(['slow', 'healthy']));

    // Sleep: the relay drops, then the connecting grace expires.
    act(() => listeners.onStatusChanged({ status: 'connecting' }));
    await advance(20_000);
    expect(connected()).toEqual([]);

    // Wake: the directory request fails and Main answers with its bounded last-known
    // snapshot, where slow's data path is not ready yet.
    listDevices().mockResolvedValueOnce({
      devices: [{ ...peers[0], online: false }, peers[1]],
      stale: true,
    });
    act(() => listeners.onStatusChanged({ status: 'online' }));
    await settle();
    act(() => listeners.onStatusChanged({
      status: 'online', directDataDeviceIds: ['slow'], dataPathChangedDeviceId: 'slow',
    }));
    await advance(30_000);

    expect(connected()).toEqual(expect.arrayContaining(['slow', 'healthy']));
  });

  it('a reachable device dropped by an offline report recovers through a retried directory read', async () => {
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const before = healthyCalls();

    // The primary relay connection reports slow offline although its route still works.
    act(() => listeners.onPresenceChanged({
      deviceId: 'slow', deviceName: 'slow', online: false, remoteControlEnabled: false,
    }));
    await settle();
    expect(connected()).not.toContain('slow');

    // The link to slow is re-established; the first directory read fails at once,
    // a later one returns a fresh answer.
    listDevices().mockClear();
    listDevices()
      .mockRejectedValueOnce(new Error('[DEVICE_LINK_NOT_CONNECTED] directory unavailable'))
      .mockResolvedValue({ devices: peers });
    act(() => listeners.onPeerLinkReopened({ deviceId: 'slow' }));
    await advance(10_000);

    expect(connected()).toContain('slow');
    // Recovery is bounded: no tight loop, and it stops once the answer is fresh.
    const reads = listDevices().mock.calls.length;
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThanOrEqual(3);
    await advance(120_000);
    expect(listDevices().mock.calls.length).toBe(reads);
    // The healthy peer is untouched by slow's recovery.
    expect(healthyCalls().subscribe).toBe(before.subscribe);
  });

  // PR #11051 review: two dropped devices whose links come back seconds apart must
  // share the directory read already in flight; Main only coalesces calls within 300ms.
  it('recoveries of several dropped devices share one in-flight directory read', async () => {
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    for (const deviceId of ['slow', 'healthy']) {
      act(() => listeners.onPresenceChanged({ deviceId, deviceName: deviceId, online: false, remoteControlEnabled: false }));
    }
    await settle();
    expect(connected()).toEqual([]);

    const directory = deferred<{ devices: typeof peers }>();
    listDevices().mockClear();
    listDevices().mockReturnValue(directory.promise);
    act(() => listeners.onPeerLinkReopened({ deviceId: 'slow' }));
    await advance(2_000);
    act(() => listeners.onPeerLinkReopened({ deviceId: 'healthy' }));
    await advance(2_000);
    expect(listDevices()).toHaveBeenCalledTimes(1);

    directory.resolve({ devices: peers });
    await settle();
    expect(connected()).toEqual(expect.arrayContaining(['slow', 'healthy']));
  });

  it('a failed bootstrap is completed without user activity, with bounded retries', async () => {
    let slowAvailable = false;
    invoke.mockImplementation(async (peer, channel) => {
      if (peer === 'slow' && channel === 'local-db:sessions:list' && !slowAvailable) {
        throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] not yet');
      }
      return channel === 'maker:schedule:list-sidebar-index-runs' ? { runs: [] } : [];
    });
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(connected()).toEqual(['healthy']);
    const slowLists = () =>
      invoke.mock.calls.filter(([peer, channel]) => peer === 'slow' && channel === 'local-db:sessions:list').length;

    // Nobody touches the computer for longer than the periodic reconcile's idle gate.
    await advance(6 * 60_000);
    // Failure backoff caps attempts well below one per tick (36 ticks in 6 minutes).
    expect(slowLists()).toBeLessThanOrEqual(10);

    slowAvailable = true;
    await advance(130_000);
    expect(connected()).toEqual(expect.arrayContaining(['slow', 'healthy']));
  });
});

// #9342: relay 重连后主进程清掉了 presence 视图,目录补齐又失败过一次 → listDevices 只
// 返回有界旧快照,里面每台设备都是 offline。那不是 presence 证据:拿它当离线判据会把在线
// 设备移出同步名单,而 presence 是增量流,一直在线的设备不会再发 presence —— 没有任何事件
// 会把它加回来,只能重启 Cindy。
describe('stale device directory', () => {
  const stalePeers = () => peers.map((peer) => ({ ...peer, online: false }));

  it('keeps an online peer in the sync list when the directory only has a stale snapshot', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    let stale = false;
    listDevices.mockImplementation(async () => (stale
      ? { devices: stalePeers(), stale: true }
      : { devices: peers }));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(remoteProjectsStore.hasDevice('healthy')).toBe(true);

    // relay 掉线再上线:主进程的 presence 视图已被清空,目录补齐失败 → 只剩旧快照。
    stale = true;
    act(() => listeners.onStatusChanged({ status: 'connecting', directDataDeviceIds: [] }));
    act(() => listeners.onStatusChanged({ status: 'online', directDataDeviceIds: [] }));
    await settle();

    // 设备仍在同步名单里:周期对账照常读它的会话列表(修复前它已被移出名单,不再有读取)。
    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(
      invoke.mock.calls.filter(([peer, channel]) => peer === 'healthy' && channel === 'local-db:sessions:list'),
    ).not.toHaveLength(0);
  });

  // 旧快照最多 30 分钟有界,过期后连旧快照都没有。目录读不到时必须有有界重读,
  // 否则重连后的视图永远停在「目录不可用」上,只能等重启。
  it('re-reads the directory with backoff until a fresh directory arrives', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    let stale = true;
    listDevices.mockImplementation(async () => (stale
      ? { devices: stalePeers(), stale: true }
      : { devices: peers }));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const initial = listDevices.mock.calls.length;

    // 5 秒后重读一次。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial + 1);
    // 退避翻倍:下一次在 10 秒后,不是 5 秒后。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial + 2);

    // 拿到新目录后不再重读。
    stale = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    const afterFresh = listDevices.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(listDevices.mock.calls.length).toBe(afterFresh);
  });

  // 目录被**权威作废**(main 侧确认 401/403 后广播)后不该再按 5–60 秒的节奏追问:
  // 每问一次都被再拒一次、再广播一次,读永远拿不到结果,只是把请求放大 —— relay 明明
  // 在线,用户看到的却是「一直在转」。
  it('stops re-reading the directory once it is authoritatively invalidated', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    listDevices.mockRejectedValue(new Error('forbidden'));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const initial = listDevices.mock.calls.length;
    expect(initial).toBeGreaterThan(0);

    // 权威作废事件 → 停掉目录重读。
    act(() => listeners.onDeviceDirectoryInvalidated({}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial);
  });

  // main 侧 `rethrowServerError` 把终态 4xx 映射成 IPC 码(404→NOT_FOUND、409→ALREADY_EXISTS、
  // 400→INVALID_PARAMS)。这种失败重问不会变好:与作废推送同一档收口,不再按 5–60 秒追问。
  // 测试价值
  // - 生产入口与可观察结果:useDeviceLinkRemoteProjects 的 reseed(listDevices) catch 分支 ——
  //   断言带终态 IPC 码的拒绝之后不再定时重读,relay 重连时仍会再读一轮。
  // - Bug/规则依据:Codex review #9360「Stop retrying terminal directory responses」:400/404
  //   没有作废推送(main 只对 401/403 广播),目录退避会对着它一直追问到进程结束。
  // - 现有覆盖缺口:既有用例只覆盖「作废推送」收口与**无码**瞬时失败继续退避,没覆盖按 IPC
  //   码可判的终态失败。
  // - 最小失败输入:listDevices 以 `[NOT_FOUND]` 拒绝、relay 在线、无作废推送,推进 120 秒。
  // - tier:unit(electronAPI 为进程内 fake,假计时器)。
  it('stops re-reading the directory when listDevices fails with a terminal IPC error', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    listDevices.mockRejectedValue(
      new Error("Error invoking remote method 'deviceLink:listDevices': Error: [NOT_FOUND] directory gone"),
    );
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const initial = listDevices.mock.calls.length;
    expect(initial).toBeGreaterThan(0);

    // relay 在线、也没有作废推送:仍然不再按 5–60 秒追问。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial);

    // 收口只对当前这次连接有效:relay 重连(relay 侧动过了)必须再读一轮 ——
    // 还是终态失败就再停,不是把目录永久摁死到重启。
    act(() => listeners.onStatusChanged({ status: 'connecting', directDataDeviceIds: [] }));
    act(() => listeners.onStatusChanged({ status: 'online', directDataDeviceIds: [] }));
    await settle();
    expect(listDevices.mock.calls.length).toBeGreaterThan(initial);
  });

  // 测试价值
  // - 生产入口与可观察结果:useDeviceLinkRemoteProjects 的目录退避 ——
  //   `getState` 拒绝、状态仍未知时,`scheduleDirectoryRetry` 不起 5–60 秒的物理读循环;
  //   状态 push 到 `online`(在线转换)后再读一轮。
  // - Bug/规则依据:Codex review #9360「Pause directory retries until relay status is
  //   known」—— 状态未知时退避只拦 `false`,一次失败的 /devices 就会在每个挂载窗口里
  //   起循环,而 relay 可能已经停掉,且没有事件保证把它停掉。
  // - 现有覆盖缺口:既有退避用例的 getState 都 resolve 成 `online`,没覆盖状态未知这条路径。
  // - 最小失败输入:getState 拒绝、listDevices 拒绝,推进 120 秒后断言调用数不增长。
  // - tier:unit(electronAPI 为进程内 fake,假计时器)。
  it('does not arm the directory retry loop while the link status is still unknown', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    listDevices.mockRejectedValue(new Error('directory unavailable'));
    getState.mockRejectedValue(new Error('getState unavailable'));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const initial = listDevices.mock.calls.length;
    expect(initial).toBeGreaterThan(0);

    // 状态未知:推进 120 秒也不该起 5–60 秒的物理读循环。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial);

    // 恢复挂在状态转换上:push 到 online 必须再读一轮(之后退避照常,状态已知)。
    act(() => listeners.onStatusChanged({ status: 'online', directDataDeviceIds: [] }));
    await settle();
    expect(listDevices.mock.calls.length).toBeGreaterThan(initial);
  });

  // 跳过旧快照的 offline 行不能把冷缓存设备永远留在「检测中」:缓存种入时标 connecting,
  // 而宽限计时器只在 relay 不在线时才降级 —— relay 在线时没人收口,它会一直「检测中」。
  // 旧快照的 offline 至少能证明此刻连不上,收成离线(与跳过之前的呈现一致)。
  it('settles a cold-cache device the stale snapshot reports as offline', async () => {
    vi.mocked(readCachedSessionList).mockImplementation(async () => ([
      { deviceId: 'cached', deviceName: 'cached', sessions: [{ id: 's-cached' }] },
    ]) as never);
    onTestFinished(() => {
      vi.mocked(readCachedSessionList).mockImplementation(async () => []);
    });
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    listDevices.mockImplementation(async () => ({
      devices: [{ deviceId: 'cached', name: 'cached', online: false, remoteControlEnabled: false, isSelf: false }],
      stale: true,
    }));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const status = () => remoteProjectsStore.getDeviceSessions('cached')[0]?.deviceLinkConnectionStatus;
    expect(status()).toBe('disconnected');
  });

  // 服务端限流给了重试期限:退避要让过那个期限,否则每个挂载窗口都在限流窗口里继续追问。
  it('waits for the server retry deadline before re-reading a rate-limited directory', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    const deadline = Date.now() + 30_000;
    listDevices.mockImplementation(async () => ({
      devices: stalePeers(), stale: true, retryAtMs: deadline,
    }));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    const initial = listDevices.mock.calls.length;
    // 自己的阶梯是 5 秒,但期限在 30 秒后:15 秒时不该重读。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial);
    // 过了期限才重读。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial + 1);
  });

  // Chromium 计时器的延时是 32 位有符号毫秒:服务端给的 Retry-After 超过 ~24.8 天时,单次
  // setTimeout 溢出成「立刻触发」,退避变成对目录读的紧追循环。超过上限的等待必须按上限
  // 分片,每片到点按墙上时钟重新核对(Codex review #9360)。
  it('chunks a retry deadline beyond the 32-bit timer limit instead of tight-looping', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    const deadline = Date.now() + 3_000_000_000; // > 2^31 - 1(~24.8 天)
    listDevices.mockImplementation(async () => ({
      devices: stalePeers(), stale: true, retryAtMs: deadline,
    }));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    // 任何一片的延时都不该越过 32 位上限(溢出 = 立刻触发 = 紧追循环)。
    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((value): value is number => typeof value === 'number');
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_147_483_647);
    const initial = listDevices.mock.calls.length;
    // 上限之内的推进不触发重读。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000_000);
    });
    expect(listDevices.mock.calls.length).toBe(initial);
    // 分片走完、墙上期限到点之后,重读恢复(之后按自己的退避阶梯继续,这里不逐一数)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000_000_000);
    });
    expect(listDevices.mock.calls.length).toBeGreaterThan(initial);
  });

  // 账号边界:main 侧按 owner 记限流期限,渲染侧也得跟着清 —— 否则新账号的目录读失败时,
  // 退避会一直等到上一个账号留下的期限。
  it('clears the server retry deadline when the relay stops', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    const deadline = Date.now() + 60_000;
    listDevices.mockImplementation(async () => ({
      devices: stalePeers(), stale: true, retryAtMs: deadline,
    }));
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();

    // 登出 / relay 停止 = 账号边界。
    act(() => listeners.onStatusChanged({ status: 'stopped', directDataDeviceIds: [] }));
    // 新账号上线,目录读失败 → 退避按自己的阶梯(5 秒)走,不等旧期限(60 秒)。
    listDevices.mockImplementation(async () => {
      throw new Error('relay unavailable');
    });
    act(() => listeners.onStatusChanged({ status: 'online', directDataDeviceIds: [] }));
    await settle();
    const afterOnline = listDevices.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(listDevices.mock.calls.length).toBe(afterOnline + 1);
  });

  // 故障半径三问(第 3 问):触及断链/重试恢复路径的改动必须带多 peer 拓扑的用例 ——
  // 一个 peer 静默 / 被限流时,其它 peer 的行、同步资格与在途请求零感知
  // (docs/dev-rules/remote-and-mobile-adaptation.md「故障半径三问」;评审意见 4593345655)。
  //
  // 测试价值
  // - 生产入口与可观察结果:useDeviceLinkRemoteProjects 的目录重读退避 + 周期对账 ——
  //   relay 重连后目录只剩有界旧快照、且服务端给了限流期限时,断言 'healthy' 的行还在、
  //   它仍在周期对账名单里(周期读 local-db:sessions:list),并且它那次在途的会话读完成后
  //   结果照常落地;静默的那台('slow',subscribe 永不 settle)全程没牵动它。
  // - Bug/规则依据:「故障半径三问」第 3 问(多 peer 拓扑下的零感知用例);本 PR 的恢复动作
  //   (目录有界重读 + 退避 + 限流期限)必须证明作用半径不超过「目录读/信息新鲜度」这一层。
  // - 现有覆盖缺口:既有用例各管一头 —— 「旧快照全员 offline」的单设备同步资格
  //   (keeps an online peer in the sync list ...)、退避阶梯、限流期限各自单测;没有覆盖
  //   「两台被控设备并存 + 一台静默 + 限流期限 + 另一台有在途请求」同时成立的情形。
  // - 最小失败输入:listDevices 先给权威目录、之后恒返回 stale + retryAtMs;'slow' 的
  //   subscribe 永不 settle;'healthy' 的会话读被 deferred 住;relay 掉线再上线。
  // - 失败证据:去掉旧快照 offline 行的豁免(把已合格设备也按 offline 应用)→ 同步资格被
  //   撤销,「周期对账仍读它」变红;去掉有界重读 → 「过了期限才重读一次」变红。
  // - tier:unit(electronAPI 为进程内 fake,假计时器)。
  it('keeps a healthy peer unaware of a silent peer and a throttled directory', async () => {
    const listDevices = window.electronAPI.deviceLink.listDevices as unknown as ReturnType<typeof vi.fn>;
    const deadline = Date.now() + 30_000;
    let stale = false;
    listDevices.mockImplementation(async () => (stale
      ? { devices: stalePeers(), stale: true, retryAtMs: deadline }
      : { devices: peers }));

    // 'slow' 停止 ACK:subscribe 永不 settle。
    subscribe.mockImplementation((peer: string) =>
      peer === 'slow' ? new Promise(() => {}) : Promise.resolve({}));

    const row = (id: string) => ({
      id,
      title: `t-${id}`,
      workingDir: null,
      model: 'gpt-x',
      status: 'active',
      agentKind: 'codex',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // 'healthy' 的会话读:第一次落地;重连后的那次在途(等它落地)。
    const inflight = deferred<unknown[]>();
    let healthyReads = 0;
    invoke.mockImplementation(async (peer: string, channel: string) => {
      if (channel === 'maker:schedule:list-sidebar-index-runs') return { runs: [] };
      if (peer !== 'healthy' || channel !== 'local-db:sessions:list') return [];
      healthyReads += 1;
      if (healthyReads === 1) return [row('s-healthy')];
      return inflight.promise;
    });

    renderHook(() => useDeviceLinkRemoteProjects());
    await settle();
    expect(remoteProjectsStore.getDeviceSessions('healthy').map((session) => session.id)).toEqual(['s-healthy']);

    // relay 掉线再上线:presence 视图已清空,目录补齐失败 → 只剩有界旧快照,
    // 而且服务端给了限流期限(429)。
    stale = true;
    act(() => listeners.onStatusChanged({ status: 'connecting', directDataDeviceIds: [] }));
    act(() => listeners.onStatusChanged({ status: 'online', directDataDeviceIds: [] }));
    await settle();

    // 行还在:旧快照里的 offline 行不是 presence 证据,不能把已合格的设备踢掉。
    expect(remoteProjectsStore.hasDevice('healthy')).toBe(true);
    expect(remoteProjectsStore.getDeviceSessions('healthy').map((session) => session.id)).toEqual(['s-healthy']);

    // 目录重读有界:限流期限(30 秒)没到之前不追问。
    const readsAfterFlap = listDevices.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(listDevices.mock.calls.length).toBe(readsAfterFlap);
    // 过了期限才重读一次(恢复动作不放大请求)。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(listDevices.mock.calls.length).toBe(readsAfterFlap + 1);

    // 在途请求零感知:重连后的那次读落地后,结果照常并进 store(没被恢复动作取消或顶掉)——
    // 落地前是首次读的那一行,落地后换成在途读带回的那一行。
    expect(remoteProjectsStore.getDeviceSessions('healthy').map((session) => session.id)).toEqual(['s-healthy']);
    inflight.resolve([row('s-healthy-2')]);
    await settle();
    expect(
      remoteProjectsStore.getDeviceSessions('healthy').map((session) => session.id),
    ).toEqual(['s-healthy-2']);
    expect(remoteProjectsStore.getDeviceSessions('healthy')[0].deviceLinkConnectionStatus).toBe('connected');

    // 同步资格还在:周期对账照常读它(60 秒一拍),没被旧快照的 offline 行撤销。
    invoke.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(
      invoke.mock.calls.filter(([peer, channel]) => peer === 'healthy' && channel === 'local-db:sessions:list'),
    ).not.toHaveLength(0);
  });});

// Review (#8381): a cache read that lands after getState() seeds `connecting` shards. They must
// be settled against what the link will do: a standby instance (another Cindy owns the link)
// shows them offline immediately; an instance that will connect gets the normal grace and then
// falls back to offline if the link never comes up. Before the fix both stayed `connecting`.
describe('late cold-start cache hydrate', () => {
  it.each([
    { standby: true, immediately: 'disconnected', afterGrace: 'disconnected' },
    { standby: false, immediately: 'connecting', afterGrace: 'disconnected' },
  ] as const)('settles cached shards when standby=$standby', async ({ standby, immediately, afterGrace }) => {
    const cache = deferred<Array<{ deviceId: string; deviceName: string; sessions: never[] }>>();
    // The hook reads the cache from more than one place; every read sees the late snapshot.
    vi.mocked(readCachedSessionList).mockImplementation(() => cache.promise as never);
    onTestFinished(() => { vi.mocked(readCachedSessionList).mockImplementation(async () => []); });
    getState.mockResolvedValue({
      linkStatus: 'stopped', remoteControlEnabled: true, standby, disabledControlDeviceIds: [],
    });
    renderHook(() => useDeviceLinkRemoteProjects());
    await settle(); // getState settles first
    cache.resolve([{ deviceId: 'slow', deviceName: 'slow', sessions: [{ id: 's-1' }] as never[] }]);
    await settle();
    const status = () => remoteProjectsStore.getDeviceSessions('slow')[0]?.deviceLinkConnectionStatus;
    expect(status()).toBe(immediately);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(status()).toBe(afterGrace);
  });

});

