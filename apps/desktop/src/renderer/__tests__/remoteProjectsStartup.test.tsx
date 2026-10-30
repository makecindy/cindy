// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  refresh: vi.fn(async () => 'ok'),
  translate: (key: string) => key,
  readCache: vi.fn(async (): Promise<import('@/features/device-link/mirrorCacheClient').CachedDeviceSessionsSnapshot[]> => []),
  navigate: vi.fn(),
  localSessions: [{ id: 'local-B', status: 'active', source: 'desktop' }] as import('@/lib/ccAgent.types').Session[],
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: state.localSessions, isLoading: false }),
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
import { remoteProjectAliases } from '@/features/device-link/remoteProjectAliases';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { CCAgentIndexRedirect } from '@/features/cc-agent/CCAgentIndexRedirect';
import { clearLastView, saveLastChatView } from '@/features/cc-agent/lib/lastViewStore';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.refresh.mockReset().mockResolvedValue('ok');
  state.readCache.mockReset().mockResolvedValue([]);
  state.navigate.mockReset();
  state.localSessions = [{ id: 'local-B', status: 'active', source: 'desktop' }] as import('@/lib/ccAgent.types').Session[];
  clearLastView();
  vi.mocked(clearCachedDevice).mockClear();
  setDataOwnerGeneration(null, 0);
  resetRemoteDataOwnerPushFence();
  Reflect.deleteProperty(window, 'electronAPI');
});

// #7437 / unit: real startup hook + redirect + mirror. Earlier tests seeded
// bootstrap before mount, missing local-B arriving before cache/device discovery.
// Deferred IPC replies verify the visible route without network or real waits.
// Standalone on Windows: 5.01s wall / 3.38s Vitest / 62ms tests (21 cases, one worker).
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function StartupRoute() {
  useDeviceLinkRemoteProjects();
  return <CCAgentIndexRedirect />;
}

function setupStartup() {
  vi.useFakeTimers();
  const cache = deferred<Awaited<ReturnType<typeof state.readCache>>>();
  const link = deferred<{ linkStatus: string }>();
  const directory = deferred<{ devices: Array<{
    deviceId: string; name: string; online: boolean; remoteControlEnabled: boolean; isSelf: boolean;
  }> }>();
  state.readCache.mockReturnValue(cache.promise);
  const listen = () => () => {};
  let onStatus = (_event: { status: string }) => {};
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: {
    getState: () => link.promise,
    listDevices: () => directory.promise,
    subscribe: async () => {},
    unsubscribe: async () => {},
    onPresenceChanged: listen,
    onStatusChanged: (callback: typeof onStatus) => { onStatus = callback; return () => {}; },
    onAccessRevoked: listen,
    onControlTargetChanged: listen, onRemotePush: listen, onResponsivenessChanged: listen,
  } } });
  saveLastChatView({ kind: 'session', sessionId: 'remote-A' });
  return { cache, link, directory, stop: () => onStatus({ status: 'stopped' }) };
}

it('waits for late cold cache after device discovery settles', async () => {
  const { cache, link, directory } = setupStartup();
  await act(async () => { render(<StartupRoute />); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    link.resolve({ linkStatus: 'connecting' });
    directory.resolve({ devices: [{ deviceId: 'peer', name: 'Peer', online: false, remoteControlEnabled: false, isSelf: false }] });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    cache.resolve([{ deviceId: 'peer', deviceName: 'Peer', sessions: [
      { id: 'remote-A', status: 'active', source: 'desktop' } as import('@/lib/ccAgent.types').Session,
    ] }]);
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/remote-A', { replace: true });
});

it('waits across delayed getState, device discovery and the first remote snapshot', async () => {
  const { cache, link, directory } = setupStartup();
  const snapshot = deferred<string>();
  state.refresh.mockImplementationOnce(async () => {
    await snapshot.promise;
    remoteProjectsStore.setDeviceSessions('peer', 'Peer', [
      { id: 'remote-A', status: 'active', source: 'desktop' } as import('@/lib/ccAgent.types').Session,
    ]);
    return 'ok';
  });
  await act(async () => { render(<StartupRoute />); cache.resolve([]); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => { link.resolve({ linkStatus: 'online' }); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    directory.resolve({ devices: [{ deviceId: 'peer', name: 'Peer', online: true, remoteControlEnabled: true, isSelf: false }] });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => { snapshot.resolve('ok'); });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/remote-A', { replace: true });
});

it.each(['empty', 'failed'] as const)('ends the initial wait when discovery is %s', async (outcome) => {
  const { cache, link, directory } = setupStartup();
  await act(async () => { render(<StartupRoute />); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    if (outcome === 'failed') {
      // The real cache client resolves [] on failure (best-effort contract).
      cache.resolve([]);
      link.reject(new Error('state unavailable'));
      // listDevices is invoked after getState settles; reject once subscribed.
      await Promise.resolve();
      await Promise.resolve();
      directory.reject(new Error('directory unavailable'));
    } else {
      cache.resolve([]);
      link.resolve({ linkStatus: 'connecting' });
      directory.resolve({ devices: [] });
    }
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/local-B', { replace: true });
});

it('releases the initial wait when Device Link stops, ignoring late completion', async () => {
  const { cache, link, directory, stop } = setupStartup();
  await act(async () => { render(<StartupRoute />); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => { stop(); });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/local-B', { replace: true });
  await act(async () => {
    cache.resolve([]);
    link.resolve({ linkStatus: 'connecting' });
    directory.resolve({ devices: [] });
  });
  expect(state.navigate).toHaveBeenCalledTimes(1);
});

// PR #7453 / unit: the real directory IPC has no default network timeout.
// Earlier failure cases rejected; an unresolved read must also release routing
// without clearing other peers or navigating again when the late cache arrives.
it.each(['cache', 'state', 'directory'] as const)('bounds initial discovery when %s never settles', async (pending) => {
  const { cache, link, directory } = setupStartup();
  await act(async () => {
    render(<StartupRoute />);
    remoteProjectsStore.setDeviceSessions('healthy', 'Healthy', [
      { id: 'healthy-task', status: 'active', source: 'desktop' } as import('@/lib/ccAgent.types').Session,
    ]);
    if (pending !== 'cache') cache.resolve([]);
    if (pending !== 'state') link.resolve({ linkStatus: 'connecting' });
    if (pending !== 'directory') directory.resolve({ devices: [
      { deviceId: 'healthy', name: 'Healthy', online: false, remoteControlEnabled: false, isSelf: false },
      { deviceId: 'late', name: 'Late', online: false, remoteControlEnabled: false, isSelf: false },
    ] });
  });
  const peers = remoteProjectsStore.getDeviceList();
  await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/local-B', { replace: true });
  expect(remoteProjectsStore.getDeviceList()).toEqual(peers);
  expect(remoteProjectsStore.getSessionDeviceId('healthy-task')).toBe('healthy');
  await act(async () => {
    cache.resolve([{ deviceId: 'late', deviceName: 'Late', sessions: [
      { id: 'remote-A', status: 'active', source: 'desktop' } as import('@/lib/ccAgent.types').Session,
    ] }]);
    link.resolve({ linkStatus: 'connecting' });
    directory.resolve({ devices: [
      { deviceId: 'healthy', name: 'Healthy', online: false, remoteControlEnabled: false, isSelf: false },
      { deviceId: 'late', name: 'Late', online: false, remoteControlEnabled: false, isSelf: false },
    ] });
  });
  expect(state.navigate).toHaveBeenCalledTimes(1);
  if (pending === 'cache') expect(remoteProjectsStore.getSessionDeviceId('remote-A')).toBe('late');
});

it('does not let cancelled initialization settle a newly mounted synchronizer', async () => {
  const old = setupStartup();
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<StartupRoute />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  view.unmount();
  expect(remoteProjectsStore.getInitialDiscoverySettled()).toBe(true);
  const current = setupStartup();
  await act(async () => { render(<StartupRoute />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    old.cache.resolve([]);
    old.link.resolve({ linkStatus: 'connecting' });
    old.directory.resolve({ devices: [] });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(remoteProjectsStore.getInitialDiscoverySettled()).toBe(false);
  await act(async () => {
    current.cache.resolve([]);
    current.link.resolve({ linkStatus: 'connecting' });
    current.directory.resolve({ devices: [] });
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/local-B', { replace: true });
});

it('restores a known local task while remote initialization is still pending', async () => {
  setupStartup();
  saveLastChatView({ kind: 'session', sessionId: 'local-B' });
  await act(async () => { render(<StartupRoute />); });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/local-B', { replace: true });
});

// PR #7453: clear() leaves discovery settled after unmount/logout. With no local
// rows, the child used to navigate synchronously before the parent's effect reset
// discovery; local-B in earlier cases accidentally added an await to the fallback.
it('waits for remote discovery after remount when the local task list is empty', async () => {
  const previous = setupStartup();
  state.localSessions = [];
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<StartupRoute />); });
  view.unmount();
  state.navigate.mockClear();
  const current = setupStartup();
  await act(async () => { render(<StartupRoute />); });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    previous.cache.resolve([]);
    previous.link.resolve({ linkStatus: 'connecting' });
    previous.directory.resolve({ devices: [] });
  });
  expect(state.navigate).not.toHaveBeenCalled();
  await act(async () => {
    current.link.resolve({ linkStatus: 'connecting' });
    current.directory.resolve({ devices: [{ deviceId: 'peer', name: 'Peer', online: false, remoteControlEnabled: false, isSelf: false }] });
    current.cache.resolve([{ deviceId: 'peer', deviceName: 'Peer', sessions: [
      { id: 'remote-A', status: 'active', source: 'desktop' } as import('@/lib/ccAgent.types').Session,
    ] }]);
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/remote-A', { replace: true });
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

// Test value: real synchronizer hook must publish rename snapshots across bootstrap/push/recovery.
// Existing bootstrap cases only covered task rows. One peer plus a renamed host snapshot reproduces
// the missing-project-name synchronization; revoked peers must disappear. Unit/jsdom, fake timers.
it('refreshes project names on bootstrap, invalidation and reconnect and clears revoked mirrors', async () => {
  setDataOwnerGeneration('owner', 1);
  vi.useFakeTimers();
  const listeners: Record<string, (...args: any[]) => void> = {};
  let alias = 'Initial name';
  const invoke = vi.fn(async () => ({
    aliases: [{ projectKey: 'local:/repo', alias }],
    platform: 'darwin',
    ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 },
  }));
  const api = {
    invoke,
    getState: async () => ({ linkStatus: 'online' }),
    listDevices: async () => ({ devices: [
      { deviceId: 'peer', name: 'Peer', online: true, remoteControlEnabled: true, isSelf: false },
    ] }),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    ...Object.fromEntries([
      'ResponsivenessChanged', 'PresenceChanged', 'StatusChanged', 'AccessRevoked',
      'ControlTargetChanged', 'RemotePush', 'PeerLinkReset',
    ].map((name) => [`on${name}`, (callback: (...args: any[]) => void) => {
      listeners[name] = callback;
      return () => {};
    }])),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: api } });
  renderHook(() => useDeviceLinkRemoteProjects());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(remoteProjectAliases.getSnapshot().get('peer')?.aliases[0].alias).toBe('Initial name');
  expect(invoke).toHaveBeenCalledWith('peer', 'sidebar-settings:get-project-aliases', []);

  alias = 'Renamed live';
  await act(async () => {
    listeners.RemotePush({ deviceId: 'peer', channel: 'local-db:project-aliases:changed', payload: {},
      ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 } });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(remoteProjectAliases.getSnapshot().get('peer')?.aliases[0].alias).toBe('Renamed live');

  await act(async () => { listeners.StatusChanged({ status: 'connecting' }); });
  expect(remoteProjectAliases.getSnapshot().get('peer')?.aliases[0].alias).toBe('Renamed live');
  alias = 'Renamed offline';
  await act(async () => {
    listeners.StatusChanged({ status: 'online' });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(remoteProjectAliases.getSnapshot().get('peer')?.aliases[0].alias).toBe('Renamed offline');

  alias = 'After peer reset';
  await act(async () => {
    listeners.PeerLinkReset({ deviceId: 'peer' });
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(remoteProjectAliases.getSnapshot().get('peer')?.aliases[0].alias).toBe('After peer reset');
  await act(async () => { listeners.AccessRevoked({ deviceId: 'peer' }); });
  expect(remoteProjectAliases.getSnapshot().has('peer')).toBe(false);
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
