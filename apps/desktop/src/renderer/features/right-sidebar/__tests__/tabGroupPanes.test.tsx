// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:useTabGroupPanes(主窗口挂载的边组在场维护);可观察的是
 *   某组第一次有可见页签时 `tab-group:<边>` 进入面板注册表且布局树经 layout.set 多出
 *   它的 pane;页签移走后 kind 注销(树不动);窗口不能承载边组(enabled=false)时全部注销;
 *   路由离开聊天视图(onChatRoute=false)时在聊天页出现过的组「停放」而不注销(#8081),
 *   从未出现过的组不挂载,且停放不改变组空了 / 页签弹出 / 整栏分离时的注销。
 * - Bug / 规则依据:页签组模型——组的 pane 只在有页签时在场,树数据保留
 *   (architecture-invariants §3「未注册的面板允许保留在存档中但不渲染」)。
 * - 现有覆盖缺口:新 hook。
 * - 最小失败输入:一个全局页签 setTabGroup('left') + renderHook。
 * - tier:unit(jsdom,localStorage 全局页签 + stub layout 桥)。
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installedGhostsMock = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock.list,
  readInstalledGhostsSnapshot: () => installedGhostsMock.list,
}));
vi.mock('../TabGroupPanel', () => ({
  tabGroupPanelComponent: () => () => null,
}));

import { createDefaultLayout, type Layout } from '../../../../shared/layoutTree';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetSidebarTabWindowsStateForTest,
  __setSidebarTabWindowsStateForTest,
} from '@/lib/sidebarTabWindowState';
import {
  __resetPanelRegistryForTest,
  hasPanelKind,
  isPanelKindParked,
} from '@/panels/registry';
import { __resetGlobalTabsForTest, addGlobalPluginTab } from '../globalTabs';
import { _resetStore } from '../store';
import { useTabGroupPanes } from '../tabGroupPanes';
import { __resetTabGroupsForTest, setTabGroup } from '../tabGroups';

let currentLayout: Layout;
const setLayout = vi.fn(async (layout: Layout) => {
  currentLayout = layout;
});

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  __resetPanelRegistryForTest();
  __resetSidebarTabWindowsStateForTest();
  _resetStore();
  setDataOwnerGeneration('owner-a', 1);
  currentLayout = createDefaultLayout();
  setLayout.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    layout: {
      getStateSync: () => ({ layout: currentLayout }),
      onChanged: () => () => undefined,
      set: setLayout,
    },
    sidebarTabWindow: {},
  };
  installedGhostsMock.list = [
    {
      manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html', title: 'Alpha' } },
      enabled: true,
    },
  ];
});

afterEach(() => {
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  __resetPanelRegistryForTest();
  installedGhostsMock.list = [];
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useTabGroupPanes', () => {
  it('registers an edge group and inserts its pane when a visible tab lands there; unregisters when it leaves', () => {
    const tab = addGlobalPluginTab('alpha')!;
    const { rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useTabGroupPanes({ sessionId: null, enabled: props.enabled, remoteHostId: null }),
      { initialProps: { enabled: true } },
    );
    expect(hasPanelKind('tab-group:left')).toBe(false);

    act(() => setTabGroup(tab.id, 'left'));
    expect(hasPanelKind('tab-group:left')).toBe(true);
    expect(setLayout).toHaveBeenCalledTimes(1);
    const kinds = (
      currentLayout.content as { children: { node: { panelKind?: string } }[] }
    ).children.map((c) => c.node.panelKind);
    expect(kinds).toEqual(['tab-group:left', 'chat-main', 'right-tabs']);

    // 移回右侧组:kind 注销,树不动(位置记忆保留)。
    act(() => setTabGroup(tab.id, 'right'));
    expect(hasPanelKind('tab-group:left')).toBe(false);
    expect(setLayout).toHaveBeenCalledTimes(1);

    // 再移到左侧:pane 已在树里,不再写树。
    act(() => setTabGroup(tab.id, 'left'));
    expect(hasPanelKind('tab-group:left')).toBe(true);
    expect(setLayout).toHaveBeenCalledTimes(1);

    // 离开聊天视图:全部注销。
    rerender({ enabled: false });
    expect(hasPanelKind('tab-group:left')).toBe(false);
  });

  describe('离开聊天路由(onChatRoute=false)', () => {
    const renderPanes = (initial: { enabled?: boolean; onChatRoute: boolean }) =>
      renderHook(
        (props: { enabled?: boolean; onChatRoute: boolean }) =>
          useTabGroupPanes({
            sessionId: null,
            enabled: props.enabled ?? true,
            onChatRoute: props.onChatRoute,
            remoteHostId: null,
          }),
        { initialProps: initial },
      );

    it('在聊天页出现过的组停放:kind 保留并标记停放,回到聊天页解除;期间不写树', () => {
      const tab = addGlobalPluginTab('alpha')!;
      act(() => setTabGroup(tab.id, 'left'));
      const { rerender } = renderPanes({ onChatRoute: true });
      expect(setLayout).toHaveBeenCalledTimes(1);

      rerender({ onChatRoute: false });
      expect(hasPanelKind('tab-group:left')).toBe(true);
      expect(isPanelKindParked('tab-group:left')).toBe(true);

      rerender({ onChatRoute: true });
      expect(hasPanelKind('tab-group:left')).toBe(true);
      expect(isPanelKindParked('tab-group:left')).toBe(false);
      expect(setLayout).toHaveBeenCalledTimes(1);
    });

    it('从未在聊天页出现过的组不挂载:启动直接停在非聊天路由', () => {
      const tab = addGlobalPluginTab('alpha')!;
      act(() => setTabGroup(tab.id, 'left'));
      const { rerender } = renderPanes({ onChatRoute: false });
      expect(hasPanelKind('tab-group:left')).toBe(false);
      expect(setLayout).not.toHaveBeenCalled();

      rerender({ onChatRoute: true });
      expect(hasPanelKind('tab-group:left')).toBe(true);
      expect(isPanelKindParked('tab-group:left')).toBe(false);
    });

    it('停放期间组里没有页签了:注销;页签再回来也不凭空挂载', () => {
      const tab = addGlobalPluginTab('alpha')!;
      act(() => setTabGroup(tab.id, 'left'));
      const { rerender } = renderPanes({ onChatRoute: true });
      rerender({ onChatRoute: false });

      act(() => setTabGroup(tab.id, 'right'));
      expect(hasPanelKind('tab-group:left')).toBe(false);
      expect(isPanelKindParked('tab-group:left')).toBe(false);

      act(() => setTabGroup(tab.id, 'left'));
      expect(hasPanelKind('tab-group:left')).toBe(false);
    });

    it('停放期间页签弹到独立窗口:注销', () => {
      const tab = addGlobalPluginTab('alpha')!;
      act(() => setTabGroup(tab.id, 'left'));
      const { rerender } = renderPanes({ onChatRoute: true });
      rerender({ onChatRoute: false });

      act(() =>
        __setSidebarTabWindowsStateForTest({
          [tab.id]: { windowId: 'w1', sessionId: null, open: true },
        }),
      );
      expect(hasPanelKind('tab-group:left')).toBe(false);
    });

    it('整栏分离或右栏窗口状态未加载(enabled=false):聊天页上和停放中都注销', () => {
      const tab = addGlobalPluginTab('alpha')!;
      act(() => setTabGroup(tab.id, 'left'));
      const { rerender } = renderPanes({ onChatRoute: true });

      rerender({ onChatRoute: true, enabled: false });
      expect(hasPanelKind('tab-group:left')).toBe(false);

      rerender({ onChatRoute: true });
      rerender({ onChatRoute: false });
      expect(isPanelKindParked('tab-group:left')).toBe(true);
      rerender({ onChatRoute: false, enabled: false });
      expect(hasPanelKind('tab-group:left')).toBe(false);
      expect(isPanelKindParked('tab-group:left')).toBe(false);
    });
  });
});
