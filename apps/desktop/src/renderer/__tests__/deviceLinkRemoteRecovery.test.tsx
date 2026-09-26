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
