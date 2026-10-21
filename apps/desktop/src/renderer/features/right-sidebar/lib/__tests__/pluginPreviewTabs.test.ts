// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PENDING_PREVIEW_TAB_TTL_MS,
  _resetPluginPreviewTabsForTests,
  clearPendingPreviewTab,
  getPendingPreviewTabIds,
  getPluginPreviewTabIds,
  markPluginPreviewTab,
  unmarkPluginPreviewTab,
  usePendingPreviewTab,
  usePluginPreviewActive,
} from '../pluginPreviewTabs';
import { browserWebviewPool, BROWSER_WEBVIEW_POOL_CAPACITY } from '../browserWebviewPool';
import { usePreviewKeepAliveActive } from '../previewKeepAlive';
import { _resetPreviewCastingForTests, setPreviewCastingTabs } from '../previewCasting';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  _resetPluginPreviewTabsForTests();
  vi.useRealTimers();
});

describe('pluginPreviewTabs', () => {
  it('tracks tabs until cleared and drives both hooks', () => {
    const one = renderHook(() => usePendingPreviewTab('t1'));
    const any = renderHook(() => usePluginPreviewActive());
    expect(one.result.current).toBe(false);
    expect(any.result.current).toBe(false);

    act(() => markPluginPreviewTab('t1'));
    expect(one.result.current).toBe(true);
    expect(any.result.current).toBe(true);
    expect([...getPendingPreviewTabIds()]).toEqual(['t1']);

    // 首次 report 之后不再「待绑定」,但标签仍活着:右栏必须继续保持挂载(缺陷 E13)。
    act(() => clearPendingPreviewTab('t1'));
    expect(one.result.current).toBe(false);
    expect(any.result.current).toBe(true);
    expect([...getPluginPreviewTabIds()]).toEqual(['t1']);

    act(() => unmarkPluginPreviewTab('t1'));
    expect(any.result.current).toBe(false);
  });

  it('expires on its own so a guest that never loads cannot pin the layer forever', () => {
    markPluginPreviewTab('t1');
    act(() => {
      vi.advanceTimersByTime(PENDING_PREVIEW_TAB_TTL_MS + 1);
    });
    expect(getPendingPreviewTabIds().size).toBe(0);
    // 超时只结束「待绑定」,不结束标签的存活保护。
    expect([...getPluginPreviewTabIds()]).toEqual(['t1']);
  });

  it('clearing an unknown tab is a no-op', () => {
    markPluginPreviewTab('t1');
    clearPendingPreviewTab('other');
    expect([...getPendingPreviewTabIds()]).toEqual(['t1']);
  });
});

describe('usePreviewKeepAliveActive', () => {
  afterEach(() => _resetPreviewCastingForTests());

  it('is on while a tab is cast or a plugin-preview tab is alive, off otherwise', () => {
    const { result } = renderHook(() => usePreviewKeepAliveActive());
    expect(result.current).toBe(false);

    act(() => markPluginPreviewTab('p1'));
    act(() => clearPendingPreviewTab('p1'));
    expect(result.current).toBe(true);

    act(() => unmarkPluginPreviewTab('p1'));
    expect(result.current).toBe(false);

    act(() => setPreviewCastingTabs(['c1']));
    expect(result.current).toBe(true);
    act(() => setPreviewCastingTabs([]));
    expect(result.current).toBe(false);
  });
});

describe('plugin-preview tabs and the LRU pool', () => {
  afterEach(() => browserWebviewPool.releaseAll());

  it('are not evicted first, even when they are the least recently used', () => {
    markPluginPreviewTab('plugin-tab');
    browserWebviewPool.acquire('plugin-tab'); // oldest access
    for (let i = 0; i < BROWSER_WEBVIEW_POOL_CAPACITY - 1; i++) browserWebviewPool.acquire('n' + i);
    // pool is full; opening one more must evict an ordinary tab, not the plugin tab
    browserWebviewPool.acquire('overflow');
    expect(browserWebviewPool.peek('plugin-tab')).not.toBeNull();
    expect(browserWebviewPool.peek('n0')).toBeNull();
  });

  it('lose the protection when the tab is closed', () => {
    markPluginPreviewTab('plugin-tab');
    unmarkPluginPreviewTab('plugin-tab');
    browserWebviewPool.acquire('plugin-tab');
    for (let i = 0; i < BROWSER_WEBVIEW_POOL_CAPACITY - 1; i++) browserWebviewPool.acquire('n' + i);
    browserWebviewPool.acquire('overflow');
    expect(browserWebviewPool.peek('plugin-tab')).toBeNull();
  });
});
