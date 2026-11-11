/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const items = [
  {
    ghostId: 'alpha',
    instanceId: 'alpha',
    title: 'Alpha',
    icon: 'puzzle',
    manifest: { id: 'alpha', name: 'Alpha Plugin' },
    installedGhost: {},
  },
  {
    ghostId: 'workspace',
    instanceId: 'workspace',
    title: 'Workspace',
    icon: 'globe',
    manifest: { id: 'workspace', name: 'Workspace Plugin' },
    installedGhost: {},
  },
];

vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({ declared: items, routeCapable: items, sidebarVisible: items }),
}));
const placementMock = vi.hoisted(() => ({
  target: 'page' as 'page' | 'sidebar' | 'window',
  focusExistingPluginTab: vi.fn(() => false),
  openPluginInSidebar: vi.fn(),
  openPluginInWindow: vi.fn(),
  resetPluginPlacementAndReturn: vi.fn(),
  hasMemory: false,
}));
vi.mock('@/features/right-sidebar/globalTabs', () => ({
  hasPluginPlacementMemory: () => placementMock.hasMemory,
  useGlobalTabs: () => [],
}));
vi.mock('@/features/right-sidebar/tabGroups', () => ({
  useTabGroupAssignments: () => ({}),
}));
vi.mock('@/features/right-sidebar/pluginPlacement', () => ({
  resolvePluginOpenTarget: () => placementMock.target,
  focusExistingPluginTab: placementMock.focusExistingPluginTab,
  openPluginInSidebar: placementMock.openPluginInSidebar,
  openPluginInWindow: placementMock.openPluginInWindow,
  resetPluginPlacementAndReturn: placementMock.resetPluginPlacementAndReturn,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      key === 'settings.ghosts.page.manageAria' ? `Manage ${options?.name}` : key,
  }),
}));

import { GhostMainViewNavEntries } from '../GhostMainViewNavEntries';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

describe('GhostMainViewNavEntries', () => {
  it('renders the shared order, active state and encoded navigation', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GhostMainViewNavEntries variant="row" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const alphaButton = screen.getByRole('button', { name: 'Alpha' });
    const workspaceButton = screen.getByRole('button', { name: 'Workspace' });
    expect(alphaButton.getAttribute('aria-current')).toBe('page');
    expect(alphaButton.getAttribute('title')).toBe('Alpha');
    expect(alphaButton.getAttribute('data-native-title')).toBe('truncated-text');
    expect(alphaButton.querySelector('.lucide-puzzle')).toBeTruthy();
    expect(workspaceButton.querySelector('.lucide-globe')).toBeTruthy();
    expect(alphaButton.querySelector('svg')?.getAttribute('width')).toBe('15');
    expect(alphaButton.querySelector('img')).toBeNull();

    fireEvent.click(workspaceButton);
    expect(screen.getByTestId('location').textContent).toBe('/apps/workspace');

    const manageAlphaButton = screen.getByRole('button', { name: 'Manage Alpha Plugin' });
    expect(manageAlphaButton.querySelector('.lucide-sliders-horizontal')).toBeTruthy();
    fireEvent.click(manageAlphaButton);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts&ghost=alpha');
  });

  // 右键菜单:在页面 / 侧边栏 / 独立窗口中打开;有放置记忆时多一项「恢复默认位置」。
  it('offers page / sidebar / window from the context menu and resets placement when remembered', () => {
    placementMock.hasMemory = true;
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <Routes>
          <Route path="*" element={<GhostMainViewNavEntries variant="row" />} />
        </Routes>
      </MemoryRouter>,
    );
    const entry = screen.getByRole('button', { name: 'Workspace' });
    fireEvent.contextMenu(entry);
    fireEvent.click(screen.getByText('ghostMainView.openInSidebar'));
    expect(placementMock.openPluginInSidebar).toHaveBeenCalledWith(items[1].installedGhost);
    fireEvent.contextMenu(entry);
    fireEvent.click(screen.getByText('ghostMainView.openInWindow'));
    expect(placementMock.openPluginInWindow).toHaveBeenCalledWith(items[1].installedGhost);
    fireEvent.contextMenu(entry);
    fireEvent.click(screen.getByText('ghostMainView.resetPlacement'));
    expect(placementMock.resetPluginPlacementAndReturn).toHaveBeenCalledWith(items[1].installedGhost);
    placementMock.hasMemory = false;
  });

  // 测试价值
  // - 生产入口与可观察结果:左侧栏入口点击;可观察的是按放置记忆 / 插件声明解析出的目标
  //   分流到页面路由、侧边栏或独立窗口,已有页签时只聚焦不重开。
  // - Bug / 规则依据:插件可声明默认打开方式,用户放置记忆优先(页签组模型第三阶段)。
  // - 现有覆盖缺口:此前点击只会导航到页面。
  // - 最小失败输入:resolvePluginOpenTarget 返回 'window'。
  // - tier:unit(jsdom + MemoryRouter)。
  it('routes a click by the resolved open target and focuses an existing tab instead of reopening', () => {
    const view = render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GhostMainViewNavEntries variant="row" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    const entry = () => screen.getByRole('button', { name: 'Workspace' });
    placementMock.target = 'window';
    fireEvent.click(entry());
    expect(placementMock.openPluginInWindow).toHaveBeenCalledWith(items[1].installedGhost);
    expect(screen.getByTestId('location').textContent).toBe('/apps/alpha');

    placementMock.target = 'sidebar';
    fireEvent.click(entry());
    expect(placementMock.openPluginInSidebar).toHaveBeenCalledWith(items[1].installedGhost);

    placementMock.focusExistingPluginTab.mockReturnValueOnce(true);
    placementMock.openPluginInSidebar.mockClear();
    fireEvent.click(entry());
    expect(placementMock.openPluginInSidebar).not.toHaveBeenCalled();

    placementMock.target = 'page';
    fireEvent.click(entry());
    expect(screen.getByTestId('location').textContent).toBe('/apps/workspace');
    view.unmount();
  });

  it('uses the native 18px rail icon geometry without a fallback tile', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <GhostMainViewNavEntries variant="rail" />
      </MemoryRouter>,
    );

    const railIcon = screen.getByRole('button', { name: 'Alpha' }).querySelector('svg');
    expect(railIcon?.classList.contains('lucide-puzzle')).toBe(true);
    expect(railIcon?.getAttribute('width')).toBe('18');
  });
});
