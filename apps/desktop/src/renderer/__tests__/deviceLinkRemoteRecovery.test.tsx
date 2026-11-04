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
  prefetchDeviceCapabilities: vi.fn(),
  evictDeviceCapabilities: vi.fn(),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  prefetchDeviceProviders: vi.fn(),
  evictDeviceProviders: vi.fn(),
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

