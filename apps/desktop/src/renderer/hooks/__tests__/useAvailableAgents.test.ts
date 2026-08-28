// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

vi.mock('../useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  refreshLocalCapabilities: vi.fn(async () => {}),
}));

type RuntimeAgentKind = 'claude-code' | 'codex' | 'pi';
type PresenceListener = (snapshot: { deviceId: string; online: boolean }) => void;
type StatusListener = (payload: { status: 'stopped' | 'connecting' | 'online' }) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function installMakerApi() {
  const listeners = new Set<() => void>();
  const api = {
    listAvailableAgents: vi.fn<() => Promise<RuntimeAgentKind[]>>(),
    onAgentsChanged: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  (window as unknown as { electronAPI: { maker: typeof api } }).electronAPI = { maker: api };
  return { api, listeners };
}

function installDeviceLinkApi() {
  const presenceListeners = new Set<PresenceListener>();
  const statusListeners = new Set<StatusListener>();
  const api = {
    invoke: vi.fn<(deviceId: string, channel: string, args: unknown[]) => Promise<unknown>>(),
    onPresenceChanged: vi.fn((listener: PresenceListener) => {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    }),
    onStatusChanged: vi.fn((listener: StatusListener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    }),
    onRemotePush: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: { deviceLink: typeof api } }).electronAPI = {
    deviceLink: api,
  };
  return { api, presenceListeners, statusListeners };
}

describe('useAvailableAgents roster cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('ignores a pre-change roster response that resolves after the change push', async () => {
    const first = deferred<RuntimeAgentKind[]>();
    const second = deferred<RuntimeAgentKind[]>();
    const { api, listeners } = installMakerApi();
    api.listAvailableAgents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { useAvailableAgents } = await import('../useAvailableAgents');
    const { result, unmount } = renderHook(() => useAvailableAgents());

    await waitFor(() => expect(api.onAgentsChanged).toHaveBeenCalledTimes(1));
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(api.listAvailableAgents).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(['claude-code', 'codex']);
      await first.promise;
    });
    expect(result.current.availableVendors.has('pi')).toBe(false);
    unmount();
    const remounted = renderHook(() => useAvailableAgents());
    expect(remounted.result.current.loaded).toBe(false);

    await act(async () => {
      second.resolve(['claude-code', 'codex', 'pi']);
      await second.promise;
    });
    await waitFor(() => expect(remounted.result.current.availableVendors.has('pi')).toBe(true));
  });

  it('refetches a remote roster after the selected device reconnects', async () => {
    const first = deferred<RuntimeAgentKind[]>();
    const second = deferred<RuntimeAgentKind[]>();
    const { api, presenceListeners } = installDeviceLinkApi();
    api.invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { useAvailableAgents } = await import('../useAvailableAgents');
    const { result } = renderHook(() => useAvailableAgents('device-1'));

    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(['claude-code', 'codex']);
      await first.promise;
    });
    expect(result.current.availableVendors.has('pi')).toBe(false);

    act(() => {
      for (const listener of presenceListeners) listener({ deviceId: 'device-1', online: false });
      for (const listener of presenceListeners) listener({ deviceId: 'device-1', online: true });
    });
    await waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(['claude-code', 'codex', 'pi']);
      await second.promise;
    });
    await waitFor(() => expect(result.current.availableVendors.has('pi')).toBe(true));
  });

  it('shares one invalidation and result across mounted consumers', async () => {
    const first = deferred<RuntimeAgentKind[]>();
    const second = deferred<RuntimeAgentKind[]>();
    const { api, listeners } = installMakerApi();
    api.listAvailableAgents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { useAvailableAgents } = await import('../useAvailableAgents');
    const firstHook = renderHook(() => useAvailableAgents());
    const secondHook = renderHook(() => useAvailableAgents());
    await waitFor(() => expect(api.listAvailableAgents).toHaveBeenCalledTimes(1));

    await act(async () => {
      first.resolve(['claude-code', 'codex']);
      await first.promise;
    });
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(api.listAvailableAgents).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(['claude-code', 'codex', 'pi']);
      await second.promise;
    });
    await waitFor(() => {
      expect(firstHook.result.current.availableVendors.has('pi')).toBe(true);
      expect(secondHook.result.current.availableVendors.has('pi')).toBe(true);
    });
  });

  it('keeps the source subscription alive while no roster consumer is mounted', async () => {
    const first = deferred<RuntimeAgentKind[]>();
    const second = deferred<RuntimeAgentKind[]>();
    const { api, listeners } = installMakerApi();
    api.listAvailableAgents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { useAvailableAgents } = await import('../useAvailableAgents');
    const firstHook = renderHook(() => useAvailableAgents());
    await waitFor(() => expect(api.listAvailableAgents).toHaveBeenCalledTimes(1));
    await act(async () => {
      first.resolve(['claude-code', 'codex']);
      await first.promise;
    });
    firstHook.unmount();

    act(() => {
      for (const listener of listeners) listener();
    });
    expect(api.listAvailableAgents).toHaveBeenCalledTimes(1);

    const remounted = renderHook(() => useAvailableAgents());
    await waitFor(() => expect(api.listAvailableAgents).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(['claude-code', 'codex', 'pi']);
      await second.promise;
    });
    await waitFor(() => expect(remounted.result.current.availableVendors.has('pi')).toBe(true));
  });
});
