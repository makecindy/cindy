// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { castingKeepAliveStyle } from '../castingKeepAlive';
import {
  _resetPreviewCastingForTests,
  isPreviewCastingTab,
  setPreviewCastingTabs,
  usePreviewCastingTab,
} from '../previewCasting';

afterEach(() => _resetPreviewCastingForTests());

describe('previewCasting store', () => {
  it('replaces the whole set and re-renders only when membership changes', () => {
    const { result } = renderHook(() => usePreviewCastingTab('t1'));
    expect(result.current).toBe(false);

    act(() => setPreviewCastingTabs(['t1', 't2']));
    expect(result.current).toBe(true);
    expect(isPreviewCastingTab('t2')).toBe(true);

    act(() => setPreviewCastingTabs(['t2']));
    expect(result.current).toBe(false);
    expect(isPreviewCastingTab('t1')).toBe(false);
  });

  it('does not notify subscribers for an identical set', () => {
    const renders = vi.fn();
    renderHook(() => {
      renders();
      return usePreviewCastingTab('t1');
    });
    act(() => setPreviewCastingTabs(['t1']));
    const afterFirst = renders.mock.calls.length;
    act(() => setPreviewCastingTabs(['t1']));
    expect(renders.mock.calls.length).toBe(afterFirst);
  });
});

describe('castingKeepAliveStyle', () => {
  const viewport = { width: 1200, height: 800 };

  it('keeps the last measured size, transparent, click-through and out of the clipped box', () => {
    expect(castingKeepAliveStyle({ width: 420, height: 640 }, viewport)).toEqual({
      position: 'fixed',
      top: 0,
      left: 0,
      width: 420,
      height: 640,
      opacity: 0,
      pointerEvents: 'none',
      overflow: 'hidden',
    });
  });

  it('falls back to a non-zero size when never measured or measured as zero', () => {
    for (const measured of [null, { width: 0, height: 0 }]) {
      const style = castingKeepAliveStyle(measured, viewport);
      expect(style.width).toBeGreaterThan(0);
      expect(style.height).toBeGreaterThan(0);
    }
  });

  it('clamps to the viewport so the layer is never larger than the window', () => {
    const style = castingKeepAliveStyle({ width: 5000, height: 5000 }, viewport);
    expect(style.width).toBe(1200);
    expect(style.height).toBe(800);
  });
});
