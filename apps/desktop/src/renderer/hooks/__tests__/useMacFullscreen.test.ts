// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useMacFullscreen } from '../useMacFullscreen';

describe('useMacFullscreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it.each([
    ['missing', { platform: 'darwin' }],
    [
      'incompatible',
      {
        platform: 'darwin',
        getFullscreenState: false,
        onFullscreenChange: {},
      },
    ],
  ])('does not crash when an older preload has a %s fullscreen bridge', (_name, electronAPI) => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    const { result } = renderHook(() => useMacFullscreen());

    expect(result.current).toEqual({ isMac: true, isFullscreen: false, trafficLightInset: 78 });
  });

  // #8656: the native traffic-light safe area must keep its physical width when
  // the user changes interface zoom. Existing fullscreen cases only ran at 1x.
  // Minimal failure: a 0.6 startup snapshot, then a 0.5 appearance broadcast (unit).
  it('keeps the native safe area through startup, live zoom and unsubscribe', () => {
    let changed: (settings: { windowZoom: number }) => void = () => undefined;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'darwin',
        appearanceSettings: {
          getSync: () => ({ windowZoom: 0.6 }),
          onChanged: (callback: typeof changed) => {
            changed = callback;
            return unsubscribe;
          },
        },
      },
    });
    const { result, unmount } = renderHook(() => useMacFullscreen());
    expect(result.current).toMatchObject({ trafficLightInset: 130 });
    act(() => changed({ windowZoom: 0.5 }));
    expect(result.current).toMatchObject({ trafficLightInset: 156 });
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('subscribes to fullscreen changes when the bridge is available', async () => {
    const onFullscreenChange = vi.fn(() => () => undefined);
    const getFullscreenState = vi.fn(() => Promise.resolve(true));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'darwin',
        onFullscreenChange,
        getFullscreenState,
      },
    });

    const { result } = renderHook(() => useMacFullscreen());

    expect(getFullscreenState).toHaveBeenCalledOnce();
    expect(onFullscreenChange).toHaveBeenCalledOnce();
    await act(async () => undefined);
    expect(result.current.isFullscreen).toBe(true);
  });
});
