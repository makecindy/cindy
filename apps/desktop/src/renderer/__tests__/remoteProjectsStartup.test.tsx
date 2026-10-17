// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  refresh: vi.fn(async () => 'ok'),
  translate: (key: string) => key,
  readCache: vi.fn(async (): Promise<import('@/features/device-link/mirrorCacheClient').CachedDeviceSessionsSnapshot[]> => []),
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: state.translate }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, deviceId: 'self', dataOwnerId: 'owner' }),
}));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions: state.refresh,
  collectSessionListSnapshot: vi.fn(),
}));
vi.mock('@/features/device-link/mirrorCacheClient', () => ({
  clearMirrorCacheAccountState: vi.fn(),
  readCachedSessionList: state.readCache,
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
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';
import { useDeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { clearCachedDevice } from '@/features/device-link/mirrorCacheClient';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.refresh.mockClear();
  state.readCache.mockReset().mockResolvedValue([]);
  vi.mocked(clearCachedDevice).mockClear();
  Reflect.deleteProperty(window, 'electronAPI');
});

it.each(['deleted', 'refused'] as const)('handles confirmed deletion before the old cold cache returns: %s', async (outcome) => {
  vi.useFakeTimers();
  let finishCache!: (devices: Awaited<ReturnType<typeof state.readCache>>) => void;
  state.readCache.mockReturnValue(new Promise(resolve => { finishCache = resolve; }));
  const listen = () => () => {};
  const api = {
    getState: async () => ({ linkStatus: 'connecting' }),
    listDevices: vi.fn().mockRejectedValue(new Error('directory unavailable')),
    deleteDevice: vi.fn(async () => ({ deviceId: 'deleted-peer', deleted: outcome === 'deleted' })),
    unsubscribe: vi.fn(async () => {}),
    onPresenceChanged: listen,
    onStatusChanged: listen,
    onAccessRevoked: listen,
    onControlTargetChanged: listen,
    onRemotePush: listen,
    onResponsivenessChanged: listen,
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: api } });
  const { result, unmount } = renderHook(() => {
    useDeviceLinkRemoteProjects();
    return useDeviceLinkSettings(false);
  });
  await act(async () => {
    expect(await result.current.remove('deleted-peer')).toBe(outcome === 'deleted');
  });
  await act(async () => {
    finishCache(['deleted-peer', 'offline-peer'].map(deviceId => ({
      deviceId, deviceName: deviceId, sessions: [{ id: `${deviceId}-task`, status: 'active' }] as never,
    })));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(api.listDevices).toHaveBeenCalled();
  expect(remoteProjectsStore.getAllDeviceIds().sort()).toEqual(
    outcome === 'deleted' ? ['offline-peer'] : ['deleted-peer', 'offline-peer'],
  );
  expect(remoteProjectsStore.getSessionDeviceId('deleted-peer-task')).toBe(
    outcome === 'deleted' ? undefined : 'deleted-peer',
  );
  if (outcome === 'deleted') expect(clearCachedDevice).toHaveBeenCalledWith('deleted-peer');
  else expect(clearCachedDevice).not.toHaveBeenCalled();
  unmount();
});

it('ignores a directory snapshot started before confirmed deletion', async () => {
  vi.useFakeTimers();
  let finishDirectory!: (value: { devices: unknown[] }) => void;
  const directory = new Promise<{ devices: unknown[] }>(resolve => { finishDirectory = resolve; });
  const listen = () => () => {};
  const subscribe = vi.fn(async () => {});
  const api = {
    getState: async () => ({ linkStatus: 'online' }),
    listDevices: vi.fn(() => directory),
    deleteDevice: async () => ({ deviceId: 'deleted-peer', deleted: true }),
    subscribe,
    unsubscribe: vi.fn(async () => {}),
    onPresenceChanged: listen,
    onStatusChanged: listen,
    onAccessRevoked: listen,
    onControlTargetChanged: listen,
    onRemotePush: listen,
    onResponsivenessChanged: listen,
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: api } });
  const { result, unmount } = renderHook(() => {
    useDeviceLinkRemoteProjects();
    return useDeviceLinkSettings(false);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(api.listDevices).toHaveBeenCalled();
  await act(async () => { expect(await result.current.remove('deleted-peer')).toBe(true); });
  await act(async () => {
    finishDirectory({ devices: [{ deviceId: 'deleted-peer', name: 'Old peer', online: true, remoteControlEnabled: true, isSelf: false }] });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(subscribe).not.toHaveBeenCalled();
  expect(remoteProjectsStore.hasDevice('deleted-peer')).toBe(false);
  unmount();
});

it.each(['connecting', 'unknown', 'late-subscribe', 'late-snapshot', 'circuit-subscribe', 'circuit-snapshot'])('handles initial %s state without redundant bootstrap', async (initialStatus) => {
  vi.useFakeTimers();
  const listeners: Record<string, (...args: any[]) => void> = {};
  let release!: () => void;
  const subscribe = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let finishState!: (value: { linkStatus: string }) => void;
  const initialState = new Promise<{ linkStatus: string }>((resolve) => { finishState = resolve; });
  const api = {
    getState: async () => {
      if (initialStatus.startsWith('late-')) return initialState;
      if (initialStatus === 'unknown') throw new Error('temporary IPC failure');
      return { linkStatus: initialStatus.startsWith('circuit-') ? 'online' : initialStatus };
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
  if (initialStatus.startsWith('circuit-')) {
    let finishRead: (() => void) | undefined;
    if (initialStatus === 'circuit-snapshot') {
      state.refresh.mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = () => resolve('gave-up'); }));
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    }
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(true);
    await act(async () => {
      listeners.Responsiveness({ deviceId: 'peer', unresponsive: true });
      finishRead?.();
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    expect(state.refresh).toHaveBeenCalledTimes(initialStatus === 'circuit-snapshot' ? 1 : 0);
    unmount();
    return;
  }
  if (initialStatus.startsWith('late-')) {
    await act(async () => {
      listeners.Presence({ deviceId: 'peer', deviceName: 'Peer', online: true, remoteControlEnabled: true });
      await vi.advanceTimersByTimeAsync(0);
    });
    let finishRead: (() => void) | undefined;
    if (initialStatus === 'late-snapshot') {
      state.refresh.mockImplementationOnce(() => new Promise<string>((resolve) => { finishRead = () => resolve('ok'); }));
      await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    }
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(true);
    await act(async () => { finishState({ linkStatus: 'connecting' }); await vi.advanceTimersByTimeAsync(0); });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    await act(async () => { finishRead?.(); release(); await vi.advanceTimersByTimeAsync(0); });
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    expect(state.refresh).toHaveBeenCalledTimes(initialStatus === 'late-snapshot' ? 1 : 0);
    unmount();
    return;
  }
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
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().has('peer')).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(state.refresh).toHaveBeenCalledTimes(1);
  unmount();
});
