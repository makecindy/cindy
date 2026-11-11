// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:MainLayout 同时挂 `useTabGroupPanes` 与 `LayoutRoot`。可观察的是
 *   聊天页 → `/plugins` → 聊天页往返时,左 / 上 / 下边组 pane 里的 TabBody 挂载 / 卸载次数
 *   (webview 宿主随它销毁重建 = 整页重载)。
 * - Bug / 规则依据:makecindy/cindy#8081。离开聊天页时 `enabled=false` 注销边组 kind,
 *   引擎把 pane 整体卸掉;回来再注册、整页重载。
 * - 现有覆盖缺口:tabGroupPanes.test 只断言注册表有无 kind,LayoutRoot.test 不接真实
 *   的 `useTabGroupPanes`,没有任何用例看到 pane 内容有没有被重建,也没有用例看到停放态
 *   的版面(容器 0 尺寸、无分割线)。
 * - 最小失败输入:一个全局插件页签放进左组,`onChatRoute` 从 true 切到 false 再切回 true。
 * - tier:unit(jsdom,localStorage 全局页签 + stub layout 桥,TabGroupPanel 换成挂载计数桩)。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({
  mounts: {} as Record<string, number>,
  unmounts: {} as Record<string, number>,
}));
const installedGhostsMock = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock.list,
  readInstalledGhostsSnapshot: () => installedGhostsMock.list,
}));
vi.mock('../../cindy-brain/ghostPanels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cindy-brain/ghostPanels')>();
  return { ...actual, useGhostPanelsSync: () => 0 };
});
vi.mock('@/features/right-sidebar/TabGroupPanel', async () => {
  const React = await import('react');
  const cache: Record<string, () => unknown> = {};
  return {
    // TabBody 的替身:只数挂载 / 卸载,效果等同 webview 宿主的创建 / 销毁。
    tabGroupPanelComponent: (groupId: string) => {
      cache[groupId] ??= function TabBodyProbe() {
        React.useEffect(() => {
          probe.mounts[groupId] = (probe.mounts[groupId] ?? 0) + 1;
          return () => {
            probe.unmounts[groupId] = (probe.unmounts[groupId] ?? 0) + 1;
          };
        }, []);
        return React.createElement('div', { 'data-testid': `tab-body-${groupId}` });
      };
      return cache[groupId];
    },
  };
});

import { createDefaultLayout, type Layout } from '../../../shared/layoutTree';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
} from '@/features/right-sidebar/globalTabs';
import { _resetStore } from '@/features/right-sidebar/store';
import { useTabGroupPanes } from '@/features/right-sidebar/tabGroupPanes';
import {
  __resetTabGroupsForTest,
  setTabGroup,
} from '@/features/right-sidebar/tabGroups';
import { __resetSidebarTabWindowsStateForTest } from '@/lib/sidebarTabWindowState';
import {
  BuiltinPanelBridgeProvider,
  type BuiltinPanelBridge,
} from '../../panels/BuiltinPanelBridge';
import { __resetBuiltinPanelsForTest } from '../../panels/builtinPanels';
import { __resetPanelRegistryForTest } from '../../panels/registry';
import { LayoutRoot } from '../LayoutRoot';

let currentLayout: Layout;
let changedListeners: Array<(payload: { layout: Layout }) => void>;
const setLayoutMock = vi.fn(async (layout: Layout) => {
  currentLayout = layout;
  changedListeners.forEach((cb) => cb({ layout }));
});

const bridge: BuiltinPanelBridge = {
  sessionList: <div data-testid="p-sessions" />,
  chatMain: <div data-testid="p-chat" />,
  rightTabs: <div data-testid="p-right" />,
};

/** MainLayout 的相关部分:`enabled` = 窗口能承载边组,`onChatRoute` = 内容区在聊天路由。 */
function Harness({ onChatRoute, enabled = true }: { onChatRoute: boolean; enabled?: boolean }) {
  useTabGroupPanes({ sessionId: null, enabled, onChatRoute, remoteHostId: null });
  return (
    <BuiltinPanelBridgeProvider value={bridge}>
      <LayoutRoot />
    </BuiltinPanelBridgeProvider>
  );
}

const GROUPS = ['left', 'top', 'bottom'] as const;

beforeEach(() => {
  window.localStorage.clear();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
  __resetSidebarTabWindowsStateForTest();
  _resetStore();
  setDataOwnerGeneration('owner-a', 1);
  probe.mounts = {};
  probe.unmounts = {};
  currentLayout = createDefaultLayout();
  changedListeners = [];
  setLayoutMock.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    layout: {
      getStateSync: () => ({ layout: currentLayout }),
      onChanged: (cb: (payload: { layout: Layout }) => void) => {
        changedListeners.push(cb);
        return () => {
          changedListeners = changedListeners.filter((l) => l !== cb);
        };
      },
      set: setLayoutMock,
    },
    sidebarTabWindow: {},
  };
  installedGhostsMock.list = ['alpha', 'beta', 'gamma'].map((id) => ({
    manifest: { id, name: id, panel: { html: 'p.html', title: id } },
    enabled: true,
  }));
});

afterEach(() => {
  cleanup();
  __resetGlobalTabsForTest();
  __resetTabGroupsForTest();
  __resetPanelRegistryForTest();
  __resetBuiltinPanelsForTest();
  installedGhostsMock.list = [];
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function rootChild(group: 'left'): HTMLElement {
  return document.querySelector(`[data-layout-root-child-id="tab-group-${group}"]`) as HTMLElement;
}
function columnCell(group: 'top' | 'bottom'): HTMLElement {
  return document.querySelector(`[data-layout-node-id="tab-group-${group}"]`) as HTMLElement;
}
function dividerCount(): number {
  return document.querySelectorAll('[data-testid="layout-divider"]').length;
}

describe('边组 pane 往返不重建(#8081)', () => {
  it.each(GROUPS)('%s 组:聊天页 → /plugins → 聊天页,TabBody 挂载 1 次、卸载 0 次', (group) => {
    const tab = addGlobalPluginTab('alpha')!;
    act(() => setTabGroup(tab.id, group));
    const { rerender } = render(<Harness onChatRoute />);
    expect(probe.mounts[group]).toBe(1);
    // 同一个 DOM 节点贯穿往返 = 祖先链没有换类型 / 换位置(否则 Electron guest 仍会重建)。
    const body = screen.getByTestId(`tab-body-${group}`);
    const treeBefore = JSON.stringify(currentLayout);
    const writesBefore = setLayoutMock.mock.calls.length;

    rerender(<Harness onChatRoute={false} />);
    expect(probe.mounts[group]).toBe(1);
    expect(probe.unmounts[group] ?? 0).toBe(0);
    expect(screen.getByTestId(`tab-body-${group}`)).toBe(body);
    rerender(<Harness onChatRoute />);

    expect(probe.mounts[group]).toBe(1);
    expect(probe.unmounts[group] ?? 0).toBe(0);
    expect(screen.getByTestId(`tab-body-${group}`)).toBe(body);
    // 往返只是视图态:树里的 fraction 不动,也不写布局。
    expect(JSON.stringify(currentLayout)).toBe(treeBefore);
    expect(setLayoutMock.mock.calls.length).toBe(writesBefore);
  });

  it('三组同时有页签:往返后各组仍只挂载 1 次', () => {
    GROUPS.forEach((group, index) => {
      const tab = addGlobalPluginTab(['alpha', 'beta', 'gamma'][index])!;
      act(() => setTabGroup(tab.id, group));
    });
    const { rerender } = render(<Harness onChatRoute />);
    rerender(<Harness onChatRoute={false} />);
    rerender(<Harness onChatRoute />);
    for (const group of GROUPS) {
      expect(probe.mounts[group]).toBe(1);
      expect(probe.unmounts[group] ?? 0).toBe(0);
    }
  });
});

describe('停放中的边组版面', () => {
  it('左组:容器 0 宽、aria-hidden,分割线只剩聊天区与右栏之间那条', () => {
    const tab = addGlobalPluginTab('alpha')!;
    act(() => setTabGroup(tab.id, 'left'));
    const { rerender } = render(<Harness onChatRoute />);
    expect(rootChild('left').getAttribute('aria-hidden')).toBeNull();
    expect(dividerCount()).toBe(2);

    rerender(<Harness onChatRoute={false} />);
    const parked = rootChild('left');
    expect(parked.getAttribute('aria-hidden')).toBe('true');
    expect(parked.className).toContain('w-0');
    expect(parked.contains(screen.getByTestId('tab-body-left'))).toBe(true);
    expect(dividerCount()).toBe(1);
    // 聊天区仍是根上的弹性格,没有被分到固定宽度。
    expect(screen.getByTestId('p-chat').closest('[style*="width"]')).toBeNull();

    rerender(<Harness onChatRoute />);
    expect(rootChild('left').getAttribute('aria-hidden')).toBeNull();
    expect(dividerCount()).toBe(2);
  });

  it.each(['top', 'bottom'] as const)('%s 组:容器 0 高、aria-hidden,聊天列里没有横缝', (group) => {
    const tab = addGlobalPluginTab('alpha')!;
    act(() => setTabGroup(tab.id, group));
    const { rerender } = render(<Harness onChatRoute />);
    expect(columnCell(group).getAttribute('aria-hidden')).toBeNull();
    expect(dividerCount()).toBe(2);

    rerender(<Harness onChatRoute={false} />);
    const parked = columnCell(group);
    expect(parked.getAttribute('aria-hidden')).toBe('true');
    expect(parked.style.height).toBe('0px');
    expect(parked.contains(screen.getByTestId(`tab-body-${group}`))).toBe(true);
    expect(dividerCount()).toBe(1);
  });
});

describe('从未在聊天页出现过的边组', () => {
  it('启动直接停在 /plugins:不挂载;进入聊天页才挂载', () => {
    const tab = addGlobalPluginTab('alpha')!;
    act(() => setTabGroup(tab.id, 'left'));
    const { rerender } = render(<Harness onChatRoute={false} />);
    expect(probe.mounts.left ?? 0).toBe(0);
    expect(screen.queryByTestId('tab-body-left')).toBeNull();

    rerender(<Harness onChatRoute />);
    expect(probe.mounts.left).toBe(1);
  });
});

describe('停放不改变注销条件', () => {
  it('停放期间整栏分离 / 窗口状态未加载(enabled=false):卸载边组', () => {
    const tab = addGlobalPluginTab('alpha')!;
    act(() => setTabGroup(tab.id, 'left'));
    const { rerender } = render(<Harness onChatRoute />);
    rerender(<Harness onChatRoute={false} />);
    rerender(<Harness onChatRoute={false} enabled={false} />);
    expect(probe.unmounts.left).toBe(1);
    expect(screen.queryByTestId('tab-body-left')).toBeNull();
  });
});
