// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabProjectPolicy } from '../useCollabProjectPolicy';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
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
    expect(latestResult).toEqual({ enabled: false, unavailable: false, unsupported: false });

    let olderResult!: Awaited<typeof olderRefresh>;
    await act(async () => {
      older.resolve({ effectiveEnabled: true });
      olderResult = await olderRefresh;
    });
    expect(olderResult).toEqual({ enabled: false, unavailable: false, unsupported: false });
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

    expect(projectAResult).toEqual({ enabled: false, unavailable: false, unsupported: false });
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

  // ── device-link:项目级开关的真相在被控端(issue #1170)────────────────────────
  // 此前一律查控制端本机:拿被控端的路径在自己的 fs 上找 `.cindy/plugins.json` 必然落空,
  // 于是读到的是控制端自己的用户级开关,与被控端 main 的 assertCollabProjectEnabled 可能
  // 相反 —— 入口据此置灰或放行都可能是错的,用户点下去才撞 PRECONDITION_FAILED。

  function stubDeviceLink(invoke: ReturnType<typeof vi.fn>, getState = vi.fn()) {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: { plugins: { getState } },
      deviceLink: { invoke },
    };
    return { invoke, getState };
  }

  it('device-link 会话:隧道到被控端查项目级,不碰控制端本机状态', async () => {
    const invoke = vi.fn().mockResolvedValue({ effectiveEnabled: false });
    const { getState } = stubDeviceLink(invoke);

    const { result } = renderHook(() =>
      useCollabProjectPolicy('/host/proj', true, { deviceId: 'dev-1' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invoke).toHaveBeenCalledWith('dev-1', 'maker:plugins:get-state', [
      'collab',
      '/host/proj',
    ]);
    expect(getState).not.toHaveBeenCalled();
    // 被控端说这个项目关了协同 → 入口置灰,而不是照控制端自己的开关放行。
    expect(result.current.enabled).toBe(false);
  });

  it('同一路径串在两台设备上不串台(查询键含 deviceId)', async () => {
    // 两台机器上完全可能出现同一个路径 —— 只按路径做查询键会把 A 的答案当成 B 的。
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockResolvedValueOnce({ effectiveEnabled: false });
    stubDeviceLink(invoke);

    const { result, rerender } = renderHook(
      ({ deviceId }: { deviceId: string }) =>
        useCollabProjectPolicy('/Users/me/proj', true, { deviceId }),
      { initialProps: { deviceId: 'dev-a' } },
    );
    await waitFor(() => expect(result.current.enabled).toBe(true));

    rerender({ deviceId: 'dev-b' });
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(invoke).toHaveBeenNthCalledWith(2, 'dev-b', 'maker:plugins:get-state', [
      'collab',
      '/Users/me/proj',
    ]);
  });

  it('被控端版本过旧(CHANNEL_NOT_ALLOWED)→ unsupported,而不是可重试的 unavailable', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel not allowed'));
    stubDeviceLink(invoke);

    const { result } = renderHook(() =>
      useCollabProjectPolicy('/host/proj', true, { deviceId: 'dev-old' }),
    );

    await waitFor(() => expect(result.current.unsupported).toBe(true));
    // 重试永远不会成功,所以不该落进 unavailable 那条「稍后重试」提示 / onDisabledActivate。
    expect(result.current.unavailable).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.enabled).toBe(false);
  });

  it('隧道瞬时失败 → 仍是 unavailable(值得重试),不误判成版本过旧', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('tunnel closed'));
    stubDeviceLink(invoke);

    const { result } = renderHook(() =>
      useCollabProjectPolicy('/host/proj', true, { deviceId: 'dev-1' }),
    );

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.unsupported).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('不 eligible 时既不查本机也不走隧道', async () => {
    const invoke = vi.fn();
    const { getState } = stubDeviceLink(invoke);

    const { result } = renderHook(() =>
      useCollabProjectPolicy('/host/proj', false, { deviceId: 'dev-1' }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.enabled).toBe(false);
    expect(getState).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
