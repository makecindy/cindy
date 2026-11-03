// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:openPluginInWindow;可观察的是只有真的开出窗口才留下「窗口放置」记忆:
 *   弹出窗口里(main 只接受主窗 sender)不调用 open 也不记忆、open 失败会撤销记忆,
 *   正常时记忆并发出 open。
 * - Bug / 规则依据:review「副窗口点『在独立窗口中打开』记下无效的窗口放置,之后点击一直试图开窗」。
 * - 现有覆盖缺口:导航入口测试把 pluginPlacement 整个 mock 掉,没有覆盖放置记忆的写入时机。
 * - 最小失败输入:isSidebarTabWindow() 为 true;api.open 返回 rejected promise。
 * - tier:unit(jsdom localStorage + mock electronAPI)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { InstalledGhost } from '../../../../shared/ghost';

const tabWindow = vi.hoisted(() => ({ solo: false }));
vi.mock('@/lib/sidebarTabWindow', () => ({ isSidebarTabWindow: () => tabWindow.solo }));

import {
  __resetGlobalTabsForTest,
  getActiveGlobalTabId,
  isPluginWindowPlacement,
} from '../globalTabs';
import { __resetTabGroupsForTest } from '../tabGroups';
import { openPluginInWindow } from '../pluginPlacement';

const ghost = {
  manifest: { id: 'alpha', name: 'Alpha', mainView: { html: 'main.html' } },
  enabled: true,
} as unknown as InstalledGhost;

type Win = { electronAPI?: unknown };

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  setDataOwnerGeneration('owner-a', 1);
  tabWindow.solo = false;
});

afterEach(() => {
  delete (window as unknown as Win).electronAPI;
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  window.localStorage.clear();
});

describe('openPluginInWindow', () => {
  it('only remembers a window placement when the window really opens', async () => {
    const open = vi.fn(() => Promise.resolve());
    (window as unknown as Win).electronAPI = { sidebarTabWindow: { open, focus: vi.fn() } };

    // 弹出窗口里:退回侧边栏,不调用 open,也不记窗口放置。
    tabWindow.solo = true;
    openPluginInWindow(ghost);
    expect(open).not.toHaveBeenCalled();
    expect(isPluginWindowPlacement('alpha')).toBe(false);
    expect(getActiveGlobalTabId()).toBe('g_alpha');

    // 主窗口:记忆并发出 open。
    tabWindow.solo = false;
    openPluginInWindow(ghost);
    expect(open).toHaveBeenCalledTimes(1);
    expect(isPluginWindowPlacement('alpha')).toBe(true);

    // open 失败:撤销记忆。
    const failing = vi.fn(() => Promise.reject(new Error('denied')));
    (window as unknown as Win).electronAPI = {
      sidebarTabWindow: { open: failing, focus: vi.fn() },
    };
    openPluginInWindow(ghost);
    await vi.waitFor(() => expect(isPluginWindowPlacement('alpha')).toBe(false));
  });
});
