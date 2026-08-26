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
});
