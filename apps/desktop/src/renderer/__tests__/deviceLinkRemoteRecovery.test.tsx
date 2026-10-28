// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it.each(['DEVICE_LINK_CHANNEL_NOT_ALLOWED', 'UNSUPPORTED_CAPABILITY'])(
    '%s sessions subscribe is not retried', async (code) => {
      subscribe.mockImplementation((peer: string) =>
        peer === 'slow'
          ? Promise.reject(new Error(`[${code}] old peer`))
          : Promise.resolve({}),
      );
      renderHook(() => useDeviceLinkRemoteProjects());
      await settle();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(subscribe.mock.calls.filter(([peer]) => peer === 'slow')).toHaveLength(1);
    },
  );

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
});
