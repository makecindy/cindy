// @vitest-environment jsdom

/**
 * 切路由 / 切任务(前台 tabs 变化)时,同一个插件预览标签始终只对应一个 body host:
 * 同一个 tabId 不会因为「前台 + 保留」两路同时出现而被挂两次(挂两次 = 两个 guest)。
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabState } from '../../types';

const buckets = new Map<string, { hydrated: boolean; tabs: TabState[] }>();

vi.mock('../../store', () => ({
  subscribe: vi.fn(() => () => undefined),
  getBucket: (sessionId: string) => buckets.get(sessionId) ?? { hydrated: false, tabs: [] },
  findSessionIdByTabId: (tabId: string) =>
    [...buckets].find(([, bucket]) => bucket.tabs.some((tab) => tab.id === tabId))?.[0] ?? null,
}));
vi.mock('../../lib/tabHosting', () => ({ isTabHostedHere: () => true }));

import {
  _resetPluginPreviewTabsForTests,
  clearPendingPreviewTab,
  markPluginPreviewTab,
} from '../../lib/pluginPreviewTabs';
import { useRetainedBrowserTabHosts, type TabBodyHostDescriptor } from '../useRetainedBrowserTabHosts';

const previewTab: TabState = {
  id: 'preview-1',
  kind: 'web-browser',
  state: { url: 'http://127.0.0.1:60296/control' },
};

const foreground = (): TabBodyHostDescriptor => ({
  tab: previewTab,
  sessionId: 's1',
  workdir: '/w',
  remoteHostId: null,
});

describe('useRetainedBrowserTabHosts · 插件预览标签', () => {
  beforeEach(() => {
    buckets.set('s1', { hydrated: true, tabs: [previewTab] });
    markPluginPreviewTab('preview-1');
    clearPendingPreviewTab('preview-1');
  });
  afterEach(() => {
    cleanup();
    buckets.clear();
    _resetPluginPreviewTabsForTests();
  });

  it('前台 → 离开(切任务 / 切路由)→ 回来:每一步该标签都恰好一个 host', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: TabBodyHostDescriptor[] }) => useRetainedBrowserTabHosts(current),
      { initialProps: { current: [foreground()] } },
    );
    const ids = () => result.current.map((host) => host.tab.id);
    expect(ids()).toEqual(['preview-1']);

    act(() => rerender({ current: [] }));
    expect(ids()).toEqual(['preview-1']);

    act(() => rerender({ current: [foreground()] }));
    expect(ids()).toEqual(['preview-1']);

    act(() => rerender({ current: [] }));
    act(() => rerender({ current: [] }));
    expect(ids()).toEqual(['preview-1']);
  });

  it('标签关闭(从 bucket 与登记集合消失)后不再保留 host', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: TabBodyHostDescriptor[] }) => useRetainedBrowserTabHosts(current),
      { initialProps: { current: [foreground()] } },
    );
    buckets.set('s1', { hydrated: true, tabs: [] });
    _resetPluginPreviewTabsForTests();
    act(() => rerender({ current: [] }));
    expect(result.current).toEqual([]);
  });
});
