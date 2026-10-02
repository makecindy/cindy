// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseWallpaperVideoTier, useWallpaperVideoTier } from '../useWallpaperVideoTier';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('wallpaper video resolution', () => {
  it('uses cover-fit physical pixels, including portrait windows and OS scaling', () => {
    expect(chooseWallpaperVideoTier(1440, 900, 1)).toBe('standard');
    expect(chooseWallpaperVideoTier(1920, 1080, 2)).toBe('hd');
    expect(chooseWallpaperVideoTier(2560, 1440, 1)).toBe('hd');
    expect(chooseWallpaperVideoTier(800, 1300, 1)).toBe('hd');
    expect(chooseWallpaperVideoTier(1000, 700, 1.5)).toBe('standard');
  });
  it('retains the current tier near the boundary', () => {
    expect(chooseWallpaperVideoTier(1800, 900, 1, 'hd')).toBe('hd');
    expect(chooseWallpaperVideoTier(1800, 900, 1, 'standard')).toBe('standard');
    expect(chooseWallpaperVideoTier(1600, 900, 1, 'hd')).toBe('standard');
  });
  it('waits for resizing to settle and observes monitor DPI changes without a resize', () => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 900);
    vi.stubGlobal('devicePixelRatio', 1);
    const queries: Array<EventTarget & { media: string }> = [];
    vi.stubGlobal('matchMedia', vi.fn((media: string) => {
      const query = Object.assign(new EventTarget(), { media });
      queries.push(query);
      return query;
    }));
    const { result, unmount } = renderHook(() => useWallpaperVideoTier());
    expect(result.current).toBe('standard');
    act(() => {
      vi.stubGlobal('innerWidth', 2560);
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(200);
      vi.stubGlobal('innerWidth', 1440);
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe('standard');
    act(() => {
      vi.stubGlobal('devicePixelRatio', 2);
      queries[0].dispatchEvent(new Event('change'));
      vi.advanceTimersByTime(349);
    });
    expect(result.current).toBe('standard');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('hd');
    expect(queries[1].media).toContain('2dppx');
    act(() => {
      vi.stubGlobal('devicePixelRatio', 1);
      queries[1].dispatchEvent(new Event('change'));
      vi.advanceTimersByTime(350);
    });
    expect(result.current).toBe('standard');
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
