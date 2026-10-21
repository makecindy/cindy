// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { castingKeepAliveStyle, suspendFocusInside } from '../castingKeepAlive';
import {
  _resetPreviewCastingForTests,
  isPreviewCastingTab,
  setPreviewCastingTabs,
  usePreviewCastingActive,
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

  it('reports whether any casting tab is hosted', () => {
    const { result } = renderHook(() => usePreviewCastingActive());
    expect(result.current).toBe(false);
    act(() => setPreviewCastingTabs(['t1']));
    expect(result.current).toBe(true);
    act(() => setPreviewCastingTabs([]));
    expect(result.current).toBe(false);
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

describe('suspendFocusInside', () => {
  function mount() {
    const root = document.createElement('div');
    root.innerHTML =
      '<webview id="w"></webview><button id="b">x</button><input id="i" tabindex="2"><span id="s"></span>';
    document.body.appendChild(root);
    return root;
  }
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('takes focusables out of the Tab order and restores the previous tabindex', () => {
    const root = mount();
    const restore = suspendFocusInside(root);
    for (const id of ['w', 'b', 'i']) {
      expect(root.querySelector('#' + id)?.getAttribute('tabindex')).toBe('-1');
    }
    expect(root.querySelector('#s')?.hasAttribute('tabindex')).toBe(false);

    restore();
    expect(root.querySelector('#w')?.hasAttribute('tabindex')).toBe(false);
    expect(root.querySelector('#b')?.hasAttribute('tabindex')).toBe(false);
    expect(root.querySelector('#i')?.getAttribute('tabindex')).toBe('2');
  });

  it('gives up focus held inside, but leaves focus outside alone', () => {
    const root = mount();
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    outside.focus();
    suspendFocusInside(root)();
    expect(document.activeElement).toBe(outside);

    (root.querySelector('#b') as HTMLElement).focus();
    expect(root.contains(document.activeElement)).toBe(true);
    const restore = suspendFocusInside(root);
    expect(root.contains(document.activeElement)).toBe(false);
    restore();
  });

  it('also covers elements attached while suspended', async () => {
    const root = mount();
    const restore = suspendFocusInside(root);
    const late = document.createElement('webview');
    root.appendChild(late);
    await Promise.resolve();
    expect(late.getAttribute('tabindex')).toBe('-1');
    restore();
    expect(late.hasAttribute('tabindex')).toBe(false);
  });
});
