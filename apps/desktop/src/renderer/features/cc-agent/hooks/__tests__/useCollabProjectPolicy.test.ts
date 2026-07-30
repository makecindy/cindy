// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabProjectPolicy } from '../useCollabProjectPolicy';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useCollabProjectPolicy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an unavailable policy without converting it into an explicit disable', async () => {
    const getState = vi.fn().mockRejectedValue(new Error('temporary IPC failure'));
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));

    await waitFor(() => expect(result.current.unavailable).toBe(true));

    expect(result.current.enabled).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(getState).toHaveBeenCalledWith('collab', 'C:/projects/cindy');
  });

  it('refreshes the project policy when the window regains focus', async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockResolvedValueOnce({ effectiveEnabled: false });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('refreshes only when a visibility change brings the document to the foreground', async () => {
    let visibilityState: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockResolvedValueOnce({ effectiveEnabled: false });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(getState).toHaveBeenCalledTimes(1);

    visibilityState = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('allows an unavailable policy to be retried without leaving the current window', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary IPC failure'))
      .mockResolvedValueOnce({ effectiveEnabled: true });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('preserves the resolved policy while a refresh is pending', async () => {
    const pending = deferred<{ effectiveEnabled: boolean }>();
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockReturnValueOnce(pending.promise);
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.enabled).toBe(true));

    let refreshPromise!: ReturnType<typeof result.current.refresh>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(result.current.enabled).toBe(true);
    expect(result.current.loading).toBe(false);

    pending.resolve({ effectiveEnabled: false });
    await act(async () => {
      await refreshPromise;
    });
    expect(result.current.enabled).toBe(false);
  });

  it('makes an older concurrent refresh resolve with the latest policy result', async () => {
    const older = deferred<{ effectiveEnabled: boolean }>();
    const latest = deferred<{ effectiveEnabled: boolean }>();
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.enabled).toBe(true));

    let olderRefresh!: ReturnType<typeof result.current.refresh>;
    let latestRefresh!: ReturnType<typeof result.current.refresh>;
    act(() => {
      olderRefresh = result.current.refresh();
      latestRefresh = result.current.refresh();
    });

    let latestResult!: Awaited<typeof latestRefresh>;
    await act(async () => {
      latest.resolve({ effectiveEnabled: false });
      latestResult = await latestRefresh;
    });
    expect(latestResult).toEqual({ enabled: false, unavailable: false });

    let olderResult!: Awaited<typeof olderRefresh>;
    await act(async () => {
      older.resolve({ effectiveEnabled: true });
      olderResult = await olderRefresh;
    });
    expect(olderResult).toEqual({ enabled: false, unavailable: false });
    expect(result.current.enabled).toBe(false);
  });

  it('does not resolve a superseded project refresh with another project policy', async () => {
    const projectARetry = deferred<{ effectiveEnabled: boolean }>();
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary IPC failure'))
      .mockReturnValueOnce(projectARetry.promise)
      .mockResolvedValueOnce({ effectiveEnabled: true });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result, rerender } = renderHook(
      ({ workingDir }: { workingDir: string }) =>
        useCollabProjectPolicy(workingDir, true),
      { initialProps: { workingDir: 'C:\\projects\\project-a' } },
    );
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    let projectARefresh!: ReturnType<typeof result.current.refresh>;
    act(() => {
      projectARefresh = result.current.refresh();
    });

    rerender({ workingDir: 'C:\\projects\\project-b' });
    await waitFor(() => expect(result.current.enabled).toBe(true));

    let projectAResult!: Awaited<typeof projectARefresh>;
    await act(async () => {
      projectARetry.resolve({ effectiveEnabled: false });
      projectAResult = await projectARefresh;
    });

    expect(projectAResult).toEqual({ enabled: false, unavailable: false });
    expect(result.current.enabled).toBe(true);
    expect(getState).toHaveBeenNthCalledWith(2, 'collab', 'C:/projects/project-a');
    expect(getState).toHaveBeenNthCalledWith(3, 'collab', 'C:/projects/project-b');
  });

  it('does not keep global refresh listeners for ineligible sessions', async () => {
    const getState = vi.fn().mockResolvedValue({ effectiveEnabled: true });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result, rerender } = renderHook(
      ({ eligible }: { eligible: boolean }) =>
        useCollabProjectPolicy('C:\\projects\\cindy', eligible),
      { initialProps: { eligible: true } },
    );
    await waitFor(() => expect(result.current.enabled).toBe(true));

    rerender({ eligible: false });
    expect(result.current).toMatchObject({
      enabled: false,
      loading: false,
      unavailable: false,
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('cindy:project-plugin-state-changed'));
    });
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('skipQuery (remote) skips the project lookup but still honors the user/global setting', async () => {
    // codex-connector P1 回归:远端会话跳过项目级查询 (getState 不带
    // workingDir), 但用户级/全局级 collab 开关仍生效 — 此前 skipQuery 直接
    // 按 enabled: eligible 静态放行, 全局禁用时 UI toggle 可用, 直到
    // enableOrca 撞 main 的 PRECONDITION_FAILED。
    const getState = vi.fn().mockResolvedValue({ effectiveEnabled: false });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() =>
      useCollabProjectPolicy('/remote/repo', true, { skipQuery: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
    expect(result.current.unavailable).toBe(false);
    expect(getState).toHaveBeenCalledWith('collab', undefined);
  });

  it('skipQuery (remote) enables the toggle when the user/global setting is on', async () => {
    const getState = vi.fn().mockResolvedValue({ effectiveEnabled: true });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() =>
      useCollabProjectPolicy('/remote/repo', true, { skipQuery: true }),
    );

    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(getState).toHaveBeenCalledWith('collab', undefined);
  });
});
