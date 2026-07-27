// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeviceLinkDeviceList initial request', () => {
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
        onPresenceChanged: vi.fn(),
        onStatusChanged: vi.fn(
          (callback: (payload: { status: 'stopped' | 'connecting' | 'online' }) => void) => {
            statusChanged = callback;
          },
        ),
        onControlTargetChanged: vi.fn(),
      },
    });

    const { useDeviceLinkDeviceList, useDeviceLinkDeviceListSettled } =
      await import('@/features/device-link/useDeviceLinkDeviceList');
    const { result } = renderHook(() => ({
      devices: useDeviceLinkDeviceList(),
      settled: useDeviceLinkDeviceListSettled(),
    }));

    expect(result.current).toEqual({ devices: null, settled: false });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.devices).toBeNull();
    expect(listDevices).toHaveBeenCalledTimes(1);

    act(() => statusChanged?.({ status: 'online' }));
    expect(listDevices).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ devices: null, settled: false });

    await act(async () => resolveRetry?.({ devices: [] }));
    await waitFor(() => expect(result.current).toEqual({ devices: [], settled: true }));
  });
});
