// @vitest-environment jsdom
/**
 * pinnedGhostTabs —— 图钉偏好三态语义与粘性焦点的单测。
 * localStorage 走 jsdom 内置实现;模块级单例用 _resetGhostTabPinsForTest 隔离用例。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetGhostTabPinsForTest,
  AUTO_PINNED_GHOST_TAB_STATE,
  clearGhostTabPinOnClose,
  getLastFocusedPinnedGhostKind,
  ghostIdOfTabKind,
  isAutoPinnedGhostTabState,
  isGhostTabPinned,
  listPinnedGhostIds,
  markGhostTabOpened,
  pruneGhostTabPins,
  setGhostTabPinned,
  setLastFocusedPinnedGhostKind,
  subscribeGhostTabPins,
} from '../pinnedGhostTabs';

describe('pinnedGhostTabs', () => {
  beforeEach(() => {
    _resetGhostTabPinsForTest();
  });

  it('未打开过的插件不算钉住(无条目 = 出厂态)', () => {
    expect(isGhostTabPinned('cindy-art')).toBe(false);
    expect(listPinnedGhostIds()).toEqual([]);
  });

  it('markGhostTabOpened:首次打开默认钉住', () => {
    markGhostTabOpened('cindy-art');
    expect(isGhostTabPinned('cindy-art')).toBe(true);
    expect(listPinnedGhostIds()).toEqual(['cindy-art']);
  });

  it('markGhostTabOpened 不覆盖用户显式的 pinned:false', () => {
    setGhostTabPinned('cindy-art', false);
    markGhostTabOpened('cindy-art');
    expect(isGhostTabPinned('cindy-art')).toBe(false);
  });

  it('钉住偏好持久化到 localStorage,新模块实例可回读', () => {
    markGhostTabOpened('cindy-art');
    const raw = localStorage.getItem('rightSidebar.ghostTabPins');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)['cindy-art'].pinned).toBe(true);
  });

  it('clearGhostTabPinOnClose:只清 pinned:true(回到出厂态),保留 pinned:false', () => {
    markGhostTabOpened('cindy-art');
    clearGhostTabPinOnClose('cindy-art');
    expect(isGhostTabPinned('cindy-art')).toBe(false);
    // 出厂态:再次打开重新默认钉住
    markGhostTabOpened('cindy-art');
    expect(isGhostTabPinned('cindy-art')).toBe(true);

    setGhostTabPinned('cindy-mermaid', false);
    clearGhostTabPinOnClose('cindy-mermaid');
    // 显式取消钉住的条目不被关闭动作抹掉:再次打开仍不钉住
    markGhostTabOpened('cindy-mermaid');
    expect(isGhostTabPinned('cindy-mermaid')).toBe(false);
  });

  it('pruneGhostTabPins:被卸载的插件条目清除,在装的保留', () => {
    markGhostTabOpened('cindy-art');
    setGhostTabPinned('cindy-mermaid', false);
    pruneGhostTabPins(new Set(['cindy-art']));
    expect(listPinnedGhostIds()).toEqual(['cindy-art']);
    // mermaid 的 override 已被清:重新打开回到默认钉住
    markGhostTabOpened('cindy-mermaid');
    expect(isGhostTabPinned('cindy-mermaid')).toBe(true);
  });

  it('订阅者在任何写入时收到通知', () => {
    let calls = 0;
    const off = subscribeGhostTabPins(() => {
      calls += 1;
    });
    markGhostTabOpened('cindy-art');
    setGhostTabPinned('cindy-art', false);
    off();
    setGhostTabPinned('cindy-art', true);
    expect(calls).toBe(2);
  });

  it('粘性焦点:只有钉住中的面板 kind 会被记住,其它一律清空', () => {
    markGhostTabOpened('cindy-art');
    setLastFocusedPinnedGhostKind('ghost:cindy-art');
    expect(getLastFocusedPinnedGhostKind()).toBe('ghost:cindy-art');
    // 聚焦非插件页签 → 清
    setLastFocusedPinnedGhostKind('file-browser');
    expect(getLastFocusedPinnedGhostKind()).toBeNull();
    // 聚焦未钉住的插件页签 → 也清
    setLastFocusedPinnedGhostKind('ghost:cindy-art');
    setGhostTabPinned('cindy-art', false);
    // 取消钉住的瞬间粘性焦点同步失效
    expect(getLastFocusedPinnedGhostKind()).toBeNull();
  });

  it('取消钉住 / 关闭清条目时,指向该插件的粘性焦点跟着失效', () => {
    markGhostTabOpened('cindy-art');
    setLastFocusedPinnedGhostKind('ghost:cindy-art');
    clearGhostTabPinOnClose('cindy-art');
    expect(getLastFocusedPinnedGhostKind()).toBeNull();
  });

  it('ghostIdOfTabKind:只认 ghost: 前缀', () => {
    expect(ghostIdOfTabKind('ghost:cindy-art')).toBe('cindy-art');
    expect(ghostIdOfTabKind('file-browser')).toBeNull();
    expect(ghostIdOfTabKind('ghost:')).toBeNull();
  });

  it('autoPinned 标记判定', () => {
    expect(isAutoPinnedGhostTabState(AUTO_PINNED_GHOST_TAB_STATE)).toBe(true);
    expect(isAutoPinnedGhostTabState(null)).toBe(false);
    expect(isAutoPinnedGhostTabState({ autoPinned: false })).toBe(false);
    expect(isAutoPinnedGhostTabState('autoPinned')).toBe(false);
  });
});
