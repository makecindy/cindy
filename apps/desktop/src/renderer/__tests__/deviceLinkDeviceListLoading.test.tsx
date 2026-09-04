// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useDeviceLinkDeviceList 是模块级共享单例(devices / started / initialRequestSettled 都在模块作用域),
// 每个用例必须拿一份全新模块状态,否则上一个用例的 started=true 会让后面的用例不再拉取。
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useDeviceLinkDeviceList initial request', () => {
  it('silently retries a failed directory request without a later push event', async () => {
    let resolveRetry: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let resolvePresenceRefresh: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let presenceChanged: ((payload: DeviceLinkPresenceSnapshot) => void) | undefined;
    const retry = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveRetry = resolve;
    });
    const presenceRefresh = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolvePresenceRefresh = resolve;
    });
    const listDevices = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockReturnValueOnce(retry)
      .mockReturnValueOnce(presenceRefresh);
    vi.useFakeTimers();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn((callback: (payload: DeviceLinkPresenceSnapshot) => void) => {
          presenceChanged = callback;
        }),
        onStatusChanged: vi.fn(),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
      nextDeviceListRetryDelay,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('error');
    expect(result.current.settled).toBe(true);
    expect(listDevices).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(nextDeviceListRetryDelay(0));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'error', error: 'relay unavailable' },
      settled: true,
    });

    act(() =>
      presenceChanged?.({
        deviceId: 'peer-1',
        online: true,
        deviceName: 'Peer Mac',
        platform: 'darwin',
        appVersion: '0.1.27',
        lastSeenAt: 1_000,
        remoteControlEnabled: true,
        busy: false,
      }),
    );
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current.settled).toBe(true);

    await act(async () => {
      resolveRetry?.({ devices: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(3);
    expect(result.current).toEqual({
      devices: [],
      request: { status: 'ready', error: null },
      settled: true,
    });

    await act(async () => {
      resolvePresenceRefresh?.({ devices: [] });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toEqual({
      devices: [],
      request: { status: 'ready', error: null },
      settled: true,
    });
  });

  it('keeps the backoff timer when presence arrives before the first snapshot', async () => {
    let resolveBackground: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let presenceChanged: ((payload: DeviceLinkPresenceSnapshot) => void) | undefined;
    const background = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveBackground = resolve;
    });
    const listDevices = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockReturnValueOnce(background);
    vi.useFakeTimers();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn((callback: (payload: DeviceLinkPresenceSnapshot) => void) => {
          presenceChanged = callback;
        }),
        onStatusChanged: vi.fn(),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      nextDeviceListRetryDelay,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.devices).toBeNull();
    expect(result.current.request.status).toBe('error');

    // With no snapshot, a busy/lastSeen presence cannot be classified as a
    // newly visible device. It must not cancel the scheduled retry.
    act(() =>
      presenceChanged?.({
        deviceId: 'self-1',
        online: true,
        deviceName: 'This Mac',
        platform: 'darwin',
        appVersion: '0.1.27',
        lastSeenAt: 2_000,
        remoteControlEnabled: true,
        busy: true,
      }),
    );
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(result.current.request.status).toBe('error');

    await act(async () => {
      vi.advanceTimersByTime(nextDeviceListRetryDelay(0));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(2);
    resolveBackground?.({ devices: [] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('ready');
  });

  it('filters busy-only presence while a background retry is in flight when a snapshot exists', async () => {
    let resolveBackground: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let presenceChanged: ((payload: DeviceLinkPresenceSnapshot) => void) | undefined;
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const cachedDevices = [
      {
        deviceId: 'self-1',
        name: 'This Mac',
        platform: 'darwin',
        online: true,
        remoteControlEnabled: true,
        controlEnabled: true,
        isSelf: true,
      } as unknown as DeviceLinkDeviceView,
    ];
    const background = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveBackground = resolve;
    });
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce({ devices: cachedDevices })
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockReturnValueOnce(background);
    vi.useFakeTimers();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn((callback: (payload: DeviceLinkPresenceSnapshot) => void) => {
          presenceChanged = callback;
        }),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      nextDeviceListRetryDelay,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('ready');
    act(() => statusChanged?.({ status: 'online' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('error');
    expect(listDevices).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(nextDeviceListRetryDelay(0));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(3);

    act(() =>
      presenceChanged?.({
        deviceId: 'self-1',
        online: true,
        deviceName: 'This Mac',
        platform: 'darwin',
        appVersion: '0.1.27',
        lastSeenAt: 1_000,
        remoteControlEnabled: true,
        busy: true,
      }),
    );
    resolveBackground?.({ devices: cachedDevices });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(3);
  });

  it('filters busy-only presence while waiting for a background retry timer', async () => {
    let resolveBackground: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let presenceChanged: ((payload: DeviceLinkPresenceSnapshot) => void) | undefined;
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const cachedDevices = [
      {
        deviceId: 'peer-1',
        name: 'Peer Mac',
        platform: 'darwin',
        online: true,
        remoteControlEnabled: true,
        controlEnabled: true,
        isSelf: false,
      } as unknown as DeviceLinkDeviceView,
    ];
    const background = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveBackground = resolve;
    });
    const listDevices = vi
      .fn()
      .mockResolvedValueOnce({ devices: cachedDevices })
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockReturnValueOnce(background);
    vi.useFakeTimers();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn((callback: (payload: DeviceLinkPresenceSnapshot) => void) => {
          presenceChanged = callback;
        }),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      nextDeviceListRetryDelay,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('ready');

    // A status push starts a foreground refresh which fails and schedules the
    // first 2s retry. A busy-only presence must leave that timer untouched.
    act(() => statusChanged?.({ status: 'online' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current.request.status).toBe('error');

    // While the timer is pending, another busy-only presence must not issue a
    // third request or reopen loading.
    act(() =>
      presenceChanged?.({
        deviceId: 'peer-1',
        online: true,
        deviceName: 'Peer Mac',
        platform: 'darwin',
        appVersion: '0.1.27',
        lastSeenAt: 2_000,
        remoteControlEnabled: true,
        busy: true,
      }),
    );
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current.request.status).toBe('error');

    await act(async () => {
      vi.advanceTimersByTime(nextDeviceListRetryDelay(0));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(3);
    resolveBackground?.({ devices: cachedDevices });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('ready');
  });

  it('carries a relevant presence across a foreground refresh that supersedes a background retry', async () => {
    let resolveBackground: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let resolveForeground: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let resolveFollowUp: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    let presenceChanged: ((payload: DeviceLinkPresenceSnapshot) => void) | undefined;
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const background = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveBackground = resolve;
    });
    const foreground = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveForeground = resolve;
    });
    const followUp = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveFollowUp = resolve;
    });
    const listDevices = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockReturnValueOnce(background)
      .mockReturnValueOnce(foreground)
      .mockReturnValueOnce(followUp);
    vi.useFakeTimers();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn((callback: (payload: DeviceLinkPresenceSnapshot) => void) => {
          presenceChanged = callback;
        }),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      nextDeviceListRetryDelay,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('error');
    await act(async () => {
      vi.advanceTimersByTime(nextDeviceListRetryDelay(0));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(2);

    act(() => statusChanged?.({ status: 'online' }));
    expect(listDevices).toHaveBeenCalledTimes(3);

    act(() =>
      presenceChanged?.({
        deviceId: 'peer-1',
        online: true,
        deviceName: 'Peer Mac',
        platform: 'darwin',
        appVersion: '0.1.27',
        lastSeenAt: 1_000,
        remoteControlEnabled: true,
        busy: false,
      }),
    );

    resolveBackground?.({ devices: [] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(3);

    resolveForeground?.({ devices: [] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(4);

    resolveFollowUp?.({ devices: [] });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('ready');
  });

  it('cancels a pending silent retry when the relay stops', async () => {
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const listDevices = vi.fn().mockRejectedValueOnce(new Error('relay unavailable'));
    vi.useFakeTimers();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      nextDeviceListRetryDelay,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
    }));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.request.status).toBe('error');

    act(() => statusChanged?.({ status: 'stopped' }));
    await act(async () => {
      vi.advanceTimersByTime(nextDeviceListRetryDelay(0));
      await Promise.resolve();
    });
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(result.current.request).toEqual({ status: 'ready', error: null });
  });

  it('caps silent retry backoff while preserving recovery', async () => {
    const { nextDeviceListRetryDelay } =
      await import('@/features/device-link/useDeviceLinkDeviceList');
    expect(nextDeviceListRetryDelay(0)).toBe(2_000);
    expect(nextDeviceListRetryDelay(2_000)).toBe(4_000);
    expect(nextDeviceListRetryDelay(16_000)).toBe(30_000);
    expect(nextDeviceListRetryDelay(30_000)).toBe(30_000);
  });

  it('re-enters loading when online retries a rejected request with no device snapshot', async () => {
    let resolveRetry: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    const retry = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveRetry = resolve;
    });
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const listDevices = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay unavailable'))
      .mockReturnValueOnce(retry);
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));

    expect(result.current).toEqual({
      devices: null,
      request: { status: 'loading', error: null },
      settled: false,
    });
    await waitFor(() => expect(result.current.request.status).toBe('error'));
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'error', error: 'relay unavailable' },
      settled: true,
    });
    expect(listDevices).toHaveBeenCalledTimes(1);

    act(() => statusChanged?.({ status: 'online' }));
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'loading', error: null },
      settled: false,
    });

    await act(async () => resolveRetry?.({ devices: [] }));
    await waitFor(() =>
      expect(result.current).toEqual({
        devices: [],
        request: { status: 'ready', error: null },
        settled: true,
      }),
    );
  });

  // 回归 #797:云端登录 → 登出(relay 'stopped')→ 进入本地模式后不会再有 'online',
  // 设备目录必须停在终态,否则 shouldWaitForRemoteSessionBootstrap 恒为 true,
  // 侧栏「对话」分区会一直显示「加载中…」直到冷重启。
  it('settles the directory on relay stop and stays settled without a later online', async () => {
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const listDevices = vi.fn().mockResolvedValue({
      devices: [
        {
          deviceId: 'dev-a',
          name: 'Mac A',
          platform: 'darwin',
          online: true,
          remoteControlEnabled: true,
          controlEnabled: true,
          isSelf: false,
        } as unknown as DeviceLinkDeviceView,
      ],
    });
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const useProbe = () => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    });
    const { result, unmount } = renderHook(useProbe);
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.devices).toHaveLength(1);

    // 登出:清掉上一账号的远程机器(devices 回 null → 切换栏隐藏),但目录仍是终态。
    act(() => statusChanged?.({ status: 'stopped' }));
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'ready', error: null },
      settled: true,
    });
    expect(listDevices).toHaveBeenCalledTimes(1);

    // 本地模式重挂侧栏(共享单例已 started)也不得退回未结算态。
    unmount();
    const local = renderHook(useProbe);
    expect(local.result.current).toEqual({
      devices: null,
      request: { status: 'ready', error: null },
      settled: true,
    });
    expect(listDevices).toHaveBeenCalledTimes(1);
  });

  it('re-enters loading when a cloud account logs back in after a relay stop', async () => {
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    let resolveRelogin: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    const relogin = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveRelogin = resolve;
    });
    const listDevices = vi.fn().mockResolvedValueOnce({ devices: [] }).mockReturnValueOnce(relogin);
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));
    await waitFor(() =>
      expect(result.current).toEqual({
        devices: [],
        request: { status: 'ready', error: null },
        settled: true,
      }),
    );

    act(() => statusChanged?.({ status: 'stopped' }));
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'ready', error: null },
      settled: true,
    });

    // 重新登录:relay 'online' 重新拉取,首快照落地前照旧回到 loading。
    act(() => statusChanged?.({ status: 'online' }));
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'loading', error: null },
      settled: false,
    });

    await act(async () => resolveRelogin?.({ devices: [] }));
    await waitFor(() =>
      expect(result.current).toEqual({
        devices: [],
        request: { status: 'ready', error: null },
        settled: true,
      }),
    );
  });

  it('manual retry turns an error back into loading and rejects invalid payloads instead of publishing an empty directory', async () => {
    let resolveRetry: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    const retry = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveRetry = resolve;
    });
    const listDevices = vi.fn().mockResolvedValueOnce(null).mockReturnValueOnce(retry);
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        getState: vi.fn().mockResolvedValue({ linkStatus: 'online' }),
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      retryDeviceLinkDeviceList,
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
    }));

    await waitFor(() => expect(result.current.request.status).toBe('error'));
    expect(result.current.devices).toBeNull();

    act(() => retryDeviceLinkDeviceList());
    expect(result.current.request).toEqual({ status: 'loading', error: null });
    await act(async () => resolveRetry?.({ devices: [] }));
    await waitFor(() => expect(result.current.devices).toEqual([]));
    expect(result.current.request).toEqual({ status: 'ready', error: null });
  });

  it('treats an initially stopped link as an inactive remote scope, not a connection failure', async () => {
    const listDevices = vi.fn();
    const getState = vi.fn().mockResolvedValue({ linkStatus: 'stopped' });
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        getState,
        listDevices,
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));

    await waitFor(() =>
      expect(result.current).toEqual({
        devices: null,
        request: { status: 'ready', error: null },
        settled: true,
      }),
    );
    expect(getState).toHaveBeenCalledTimes(1);
    expect(listDevices).not.toHaveBeenCalled();
  });

  it('lets a stopped push beat a late online getState snapshot', async () => {
    let resolveState:
      ((value: { linkStatus: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const state = new Promise<{ linkStatus: 'stopped' | 'connecting' | 'online' }>((resolve) => {
      resolveState = resolve;
    });
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const listDevices = vi.fn();
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        getState: vi.fn().mockReturnValue(state),
        listDevices,
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));

    act(() => statusChanged?.({ status: 'stopped' }));
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'ready', error: null },
      settled: true,
    });

    await act(async () => resolveState?.({ linkStatus: 'online' }));
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'ready', error: null },
      settled: true,
    });
    expect(listDevices).not.toHaveBeenCalled();
  });

  it('starts loading and fetches the directory when a stopped link becomes online', async () => {
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    let resolveDevices: ((value: { devices: DeviceLinkDeviceView[] }) => void) | undefined;
    const response = new Promise<{ devices: DeviceLinkDeviceView[] }>((resolve) => {
      resolveDevices = resolve;
    });
    const listDevices = vi.fn().mockReturnValue(response);
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        getState: vi.fn().mockResolvedValue({ linkStatus: 'stopped' }),
        listDevices,
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));
    await waitFor(() => expect(result.current.request.status).toBe('ready'));

    act(() => statusChanged?.({ status: 'online' }));
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({
      devices: null,
      request: { status: 'loading', error: null },
      settled: false,
    });

    await act(async () => resolveDevices?.({ devices: [] }));
    await waitFor(() =>
      expect(result.current).toEqual({
        devices: [],
        request: { status: 'ready', error: null },
        settled: true,
      }),
    );
  });

  it('re-probes link state on manual retry and does not call listDevices after a missed stop', async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ linkStatus: 'online' })
      .mockResolvedValueOnce({ linkStatus: 'stopped' });
    const listDevices = vi.fn().mockRejectedValueOnce(new Error('relay unavailable'));
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        getState,
        listDevices,
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(),
        onControlTargetChanged: vi.fn(),
      },
    });

    const {
      retryDeviceLinkDeviceList,
      useDeviceLinkDeviceList,
      useDeviceLinkDeviceListRequestState,
      useDeviceLinkDeviceListSettled,
    } = await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      request: useDeviceLinkDeviceListRequestState(),
      settled: useDeviceLinkDeviceListSettled(),
    }));
    await waitFor(() => expect(result.current.request.status).toBe('error'));

    act(() => retryDeviceLinkDeviceList());
    expect(result.current.request).toEqual({ status: 'loading', error: null });
    await waitFor(() =>
      expect(result.current).toEqual({
        devices: null,
        request: { status: 'ready', error: null },
        settled: true,
      }),
    );
    expect(getState).toHaveBeenCalledTimes(2);
    expect(listDevices).toHaveBeenCalledTimes(1);
  });

  it('relay stop after selecting a remote device falls back visibly and keeps the local escape action', async () => {
    let statusChanged:
      ((payload: { status: 'stopped' | 'connecting' | 'online' }) => void) | undefined;
    const listDevices = vi.fn().mockResolvedValue({
      devices: [
        {
          deviceId: 'dev-a',
          name: 'Mac A',
          platform: 'darwin',
          online: true,
          remoteControlEnabled: true,
          controlEnabled: true,
          isSelf: false,
        } as unknown as DeviceLinkDeviceView,
      ],
    });
    vi.stubGlobal('electronAPI', {
      deviceLink: {
        listDevices,
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });
    window.localStorage.setItem('cc-agent.sidebar.selectedMachines', JSON.stringify(['dev-a']));

    const { useMachineSwitcher } = await import('@/features/device-link/useMachineSwitcher');
    const { MACHINE_ALL, MACHINE_LOCAL, setSelectedMachineOwner } =
      await import('@/features/device-link/selectedMachineStore');
    setSelectedMachineOwner('device-list-test-owner');
    const { result } = renderHook(useMachineSwitcher);

    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.selectedDeviceId).toEqual(['dev-a']);
    expect(result.current.hasRemote).toBe(true);

    act(() => statusChanged?.({ status: 'stopped' }));
    expect(result.current.devices).toEqual([]);
    expect(result.current.selectedDeviceId).toBe(MACHINE_ALL);
    // raw 仍记着 dev-a，因此入口保留；菜单中可显式选「本机」。
    expect(result.current.hasRemote).toBe(true);

    act(() => result.current.select([MACHINE_LOCAL]));
    expect(result.current.selectedDeviceId).toEqual([MACHINE_LOCAL]);
    expect(result.current.hasRemote).toBe(false);
  });
});
