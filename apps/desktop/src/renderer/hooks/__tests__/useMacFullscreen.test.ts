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
    ['incompatible', {
      platform: 'darwin',
      getFullscreenState: false,
      onFullscreenChange: {},
    }],
  ])('does not crash when an older preload has a %s fullscreen bridge', (_name, electronAPI) => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: electronAPI,
    });

    const { result } = renderHook(() => useMacFullscreen());

    expect(result.current).toEqual({ isMac: true, isFullscreen: false });
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
