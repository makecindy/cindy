// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ refresh: vi.fn(async () => 'ok') }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, deviceId: 'self', dataOwnerId: 'owner' }),
}));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: state.refresh,
  collectSessionListSnapshot: vi.fn(),
}));
vi.mock('@/features/device-link/mirrorCacheClient', () => ({
  clearMirrorCacheAccountState: vi.fn(),
  readCachedSessionList: async () => [],
  sessionListOwnerTokensReady: () => true,
  cancelSessionListPersist: vi.fn(),
  scheduleSessionListPersist: vi.fn(),
  clearCachedDevice: vi.fn(),
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
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.refresh.mockClear();
  Reflect.deleteProperty(window, 'electronAPI');
});

it.each(['connecting', 'unknown'])('handles initial %s state without redundant bootstrap', async (initialStatus) => {
  vi.useFakeTimers();
  const listeners: Record<string, (...args: any[]) => void> = {};
  let release!: () => void;
  const subscribe = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const api = {
    getState: async () => {
      if (initialStatus === 'unknown') throw new Error('temporary IPC failure');
      return { linkStatus: initialStatus };
    },
    listDevices: async () => ({
      devices: [
        { deviceId: 'peer', name: 'Peer', online: true, remoteControlEnabled: true, isSelf: false },
      ],
    }),
    subscribe,
    unsubscribe: vi.fn(async () => {}),
    ...Object.fromEntries(
      ['Responsiveness', 'Presence', 'Status', 'AccessRevoked', 'ControlTarget'].map((name) => [
        `on${name}Changed`,
        (callback: (...args: any[]) => void) => {
          listeners[name] = callback;
          return () => {};
        },
      ]),
    ),
    onAccessRevoked: () => () => {},
    onRemotePush: () => () => {},
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: api } });
  const { unmount } = renderHook(() => useDeviceLinkRemoteProjects());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  if (initialStatus === 'unknown') {
    expect(subscribe).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    unmount();
    return;
  }
  expect(subscribe).not.toHaveBeenCalled();
  await act(async () => {
    listeners.Status({ status: 'online' });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).toHaveBeenCalledTimes(1);
  await act(async () => {
    listeners.Status({ status: 'online' });
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    listeners.Status({ status: 'connecting' });
    listeners.Status({ status: 'online' });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).toHaveBeenCalledTimes(2);
  await act(async () => {
    listeners.Status({ status: 'connecting' });
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  unmount();
});
