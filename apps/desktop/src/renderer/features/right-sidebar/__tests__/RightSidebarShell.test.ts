// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { AppShortcutOverrides } from '../../../../shared/appShortcuts';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
}));

vi.mock('../plugins', () => ({}));

import { RightSidebarShell } from '../RightSidebarShell';
import { _resetRsbBrowserBridgeForTests } from '../lib/rsbBrowserBridge';
import { _resetStore, closeTab } from '../store';
import { CHROME_ACTIONS_GEOMETRY } from '@/components/layout/chromeActionsGeometry';

interface RightSidebarTabsIpcStub {
  list: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
}

type RsbBrowserCommand =
  | 'go-back'
  | 'go-forward'
  | 'reload'
  | 'close-tab'
  | 'right-tab-prev'
  | 'right-tab-next';

let rsbBrowserCommandListeners: Array<(payload: { command: RsbBrowserCommand }) => void> = [];

function makeRightSidebarTabsIpc(): RightSidebarTabsIpcStub {
  return {
    list: vi.fn(async () => ({ tabs: [], activeTabId: null })),
    upsert: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => ({ ok: true })),
    setActive: vi.fn(async () => ({ ok: true })),
    reorder: vi.fn(async () => ({ ok: true })),
  };
}

function installElectronApi(tabsIpc: RightSidebarTabsIpcStub, fullscreen = false): void {
  (
    window as unknown as {
      electronAPI: {
        localDb: { rightSidebarTabs: RightSidebarTabsIpcStub };
        rsbBrowserBridge: {
          setActiveSession: ReturnType<typeof vi.fn>;
          release: ReturnType<typeof vi.fn>;
          snapshot: ReturnType<typeof vi.fn>;
          onPin: ReturnType<typeof vi.fn>;
          onUnpin: ReturnType<typeof vi.fn>;
          onTabOpRequest: ReturnType<typeof vi.fn>;
          tabOpResult: ReturnType<typeof vi.fn>;
          setForeground: ReturnType<typeof vi.fn>;
          forceKill: ReturnType<typeof vi.fn>;
          onResourceEvent: ReturnType<typeof vi.fn>;
        };
        gitReview: { summary: ReturnType<typeof vi.fn> };
        onRsbBrowserPopup: ReturnType<typeof vi.fn>;
        onRsbBrowserCommand: (
          callback: (payload: { command: RsbBrowserCommand }) => void,
        ) => () => void;
        getFullscreenState: () => Promise<boolean>;
        onFullscreenChange: (callback: (fullscreen: boolean) => void) => () => void;
        appShortcuts: {
          getState: () => { platform: string; overrides: AppShortcutOverrides };
          onChanged: ReturnType<typeof vi.fn>;
        };
        platform: string;
      };
    }
  ).electronAPI = {
    localDb: { rightSidebarTabs: tabsIpc },
    rsbBrowserBridge: {
      setActiveSession: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      snapshot: vi.fn(async () => ({ ok: true, dropped: [], kept: 0, pinnedTabIds: [] })),
      onPin: vi.fn(() => () => undefined),
      onUnpin: vi.fn(() => () => undefined),
      onTabOpRequest: vi.fn(() => () => undefined),
      tabOpResult: vi.fn(async () => undefined),
      setForeground: vi.fn(async () => undefined),
      forceKill: vi.fn(async () => undefined),
      onResourceEvent: vi.fn(() => () => undefined),
    },
    gitReview: {
      summary: vi.fn(async () => ({
        scope: {
          sessionId: 's1',
          workdir: '/tmp/repo',
          worktreePath: '/tmp/repo',
          workingDir: '/tmp/repo',
          repoRoot: '/tmp/repo',
          branch: 'main',
          headOid: null,
          isDetached: false,
          isUnborn: false,
          source: 'worktree',
          aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
          disabledReason: null,
          disabledMessage: null,
          resolutionChain: [],
        },
        dirty: true,
        stagedFiles: 0,
        unstagedFiles: 1,
        untrackedFiles: 0,
        unmergedFiles: 0,
        writeDisabledReasons: [],
      })),
    },
    onRsbBrowserPopup: vi.fn(() => () => undefined),
    onRsbBrowserCommand: (callback) => {
      rsbBrowserCommandListeners.push(callback);
      return () => {
        rsbBrowserCommandListeners = rsbBrowserCommandListeners.filter((cb) => cb !== callback);
      };
    },
    getFullscreenState: vi.fn(async () => fullscreen),
    onFullscreenChange: vi.fn(() => () => undefined),
    appShortcuts: {
      getState: () => ({ platform: 'darwin', overrides: {} }),
      onChanged: vi.fn(() => () => undefined),
    },
    platform: 'darwin',
  };
}

function dispatchShortcut(
  code: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    code,
    bubbles: true,
    cancelable: true,
    ...mods,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe('RightSidebarShell empty state', () => {
  let tabsIpc: RightSidebarTabsIpcStub;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    _resetStore();
    _resetRsbBrowserBridgeForTests();
    rsbBrowserCommandListeners = [];
    tabsIpc = makeRightSidebarTabsIpc();
    installElectronApi(tabsIpc);
  });

  afterEach(() => {
    _resetStore();
    _resetRsbBrowserBridgeForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('cycles right sidebar tabs in strip order and wraps around', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-file', kind: 'file-browser', state: null },
        { id: 'tab-terminal', kind: 'terminal', state: null },
      ],
      activeTabId: 'tab-terminal',
    });

    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.kinds.terminal')).toBeTruthy());
    dispatchShortcut('BracketRight', { metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(tabsIpc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: 'tab-file' }),
    );
  });

  it('does not cycle when the shell is hidden or only one tab exists', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-file', kind: 'file-browser', state: null },
        { id: 'tab-terminal', kind: 'terminal', state: null },
      ],
      activeTabId: 'tab-file',
    });
    const { unmount } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: false,
        isMac: true,
        unifiedTopbar: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy(),
    );
    const hiddenShortcut = dispatchShortcut('BracketRight', { metaKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hiddenShortcut.defaultPrevented).toBe(true);
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
    unmount();

    tabsIpc.list.mockResolvedValueOnce({
      tabs: [{ id: 'tab-file', kind: 'file-browser', state: null }],
      activeTabId: 'tab-file',
    });
    render(
      createElement(RightSidebarShell, {
        sessionId: 's2',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy(),
    );
    const singleTabShortcut = dispatchShortcut('BracketRight', { metaKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(singleTabShortcut.defaultPrevented).toBe(true);
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
  });

  it('also works in the detached sidebar window path', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-file', kind: 'file-browser', state: null },
        { id: 'tab-terminal', kind: 'terminal', state: null },
      ],
      activeTabId: 'tab-file',
    });

    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy(),
    );
    dispatchShortcut('Tab', { ctrlKey: true });
    await waitFor(() =>
      expect(tabsIpc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: 'tab-terminal' }),
    );
  });

  it('cycles tabs from a focused webview guest command', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-file', kind: 'file-browser', state: null },
        { id: 'tab-browser', kind: 'web-browser', state: null },
      ],
      activeTabId: 'tab-browser',
    });

    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );

    await waitFor(() => expect(rsbBrowserCommandListeners).toHaveLength(1));
    act(() => {
      rsbBrowserCommandListeners.forEach((listener) => listener({ command: 'right-tab-next' }));
    });
    await waitFor(() =>
      expect(tabsIpc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: 'tab-file' }),
    );
  });

  it('keeps the empty guide visible and uses the mac unified topbar', async () => {
    const { container } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(tabsIpc.list).toHaveBeenCalledOnce();
    expect(tabsIpc.upsert).not.toHaveBeenCalled();
    expect(window.electronAPI.gitReview.summary as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(container.firstElementChild?.className).toContain('min-h-0');
    expect(container.firstElementChild?.className).toContain('overflow-hidden');
    expect(screen.queryByTestId('right-sidebar-tab-bar')).toBeNull();
    const topbar = screen.getByTestId('right-sidebar-unified-topbar');
    expect(topbar.className).toContain('h-[46px]');
    expect(topbar.className).toContain('shrink-0');
    expect(topbar.className).toContain('flex-none');
    const strip = screen.getByTestId('right-sidebar-tab-strip');
    expect(strip.className).toContain('flex-1');
    // 合并顶栏走 chip 变体:strip 垂直居中,与「+」/ 浮层按钮同一水平中线。
    expect(strip.className).toContain('items-center');
    expect(screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' })).toBeTruthy();
  });

  it('reserves the fullscreen ChromeActions area in the maximized unified topbar', async () => {
    installElectronApi(tabsIpc, true);
    const { rerender } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        reserveLeftChromeActions: true,
      }),
    );

    await waitFor(() => {
      const spacer = screen.getByTestId('right-sidebar-left-chrome-actions-spacer');
      expect(spacer.style.width).toBe(
        `${CHROME_ACTIONS_GEOMETRY.defaultLeft + CHROME_ACTIONS_GEOMETRY.clusterWidth}px`,
      );
    });
    const spacer = screen.getByTestId('right-sidebar-left-chrome-actions-spacer');
    expect(
      (spacer.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');

    rerender(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        reserveLeftChromeActions: false,
      }),
    );
    expect(screen.queryByTestId('right-sidebar-left-chrome-actions-spacer')).toBeNull();
  });

  it('keeps the traffic-light offset when reserving ChromeActions outside fullscreen', async () => {
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        reserveLeftChromeActions: true,
      }),
    );

    const spacer = await screen.findByTestId('right-sidebar-left-chrome-actions-spacer');
    expect(spacer.style.width).toBe(
      `${CHROME_ACTIONS_GEOMETRY.macTrafficLightLeft + CHROME_ACTIONS_GEOMETRY.clusterWidth}px`,
    );
  });

  it('renders detach/maximize in the topbar when panel is docked left (mac M2), spacer when right or maximized', async () => {
    // 贴左:窗口右上浮层只剩折叠 toggle(恒钉窗口右上角,2026-07-09 Lizi 口径),
    // detach / maximize 是面板自属控件,必须由 Shell 顶栏右端自渲染,否则面板
    // 控件全体消失(mac 实测 bug);折叠 toggle 不下沉进面板。
    const onDetach = vi.fn();
    const onMaximize = vi.fn();
    const { unmount } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        panelSide: 'left',
        onDetach,
        onMaximize,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    const actions = screen.getByTestId('right-sidebar-topbar-actions');
    expect(actions).toBeTruthy();
    screen.getByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' }).click();
    expect(onDetach).toHaveBeenCalledOnce();
    screen.getByRole('button', { name: 'rightSidebar.tabs.controls.maximizeAria' }).click();
    expect(onMaximize).toHaveBeenCalledOnce();
    // 折叠 toggle 不在面板顶栏(恒在 MainLayout 窗口右上浮层)。
    expect(screen.queryByRole('button', { name: 'contentHeader.collapsePanel' })).toBeNull();
    unmount();

    // 贴左 + maximize 撑满:面板成为最右 pane,浮层接管三按钮,Shell 回落 spacer。
    const { unmount: unmountMax } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        panelSide: 'left',
        isMaximized: true,
        onDetach,
        onMaximize,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.queryByTestId('right-sidebar-topbar-actions')).toBeNull();
    unmountMax();

    // 贴右(默认):按钮在 MainLayout 浮层,Shell 只渲染让位 spacer。
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onDetach,
        onMaximize,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.queryByTestId('right-sidebar-topbar-actions')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' }),
    ).toBeNull();
  });

  it('keeps the existing 36px TabBar host on Windows', async () => {
    const onCloseSidebar = vi.fn();
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: false,
        onCloseSidebar,
        onMaximize: vi.fn(),
        onDetach: vi.fn(),
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.queryByTestId('right-sidebar-unified-topbar')).toBeNull();
    const tabbar = screen.getByTestId('right-sidebar-tab-bar');
    expect(tabbar.className).toContain('h-[36px]');
    expect(tabbar.className).toContain('shrink-0');
    expect(tabbar.className).toContain('flex-none');
    // Win TabBar 维持 flush 变体(贴底 tab),strip 底对齐,零视觉改动。
    expect(screen.getByTestId('right-sidebar-tab-strip').className).toContain('items-end');
    const collapseButton = screen.getByRole('button', {
      name: 'rightSidebar.tabs.controls.closeAria',
    });
    collapseButton.click();
    expect(onCloseSidebar).toHaveBeenCalledOnce();
  });

  it('keeps the legacy TabBar without window controls for the detached mac window (no unifiedTopbar)', async () => {
    // SidebarWindowLayout 不传 unifiedTopbar:子窗口有自己的 50px chrome,
    // Shell 必须维持旧 36px TabBar,不能再叠一条合并顶栏(本期子窗口零改动)。
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.queryByTestId('right-sidebar-unified-topbar')).toBeNull();
    const tabbar = screen.getByTestId('right-sidebar-tab-bar');
    expect(tabbar.className).toContain('h-[36px]');
    // isMac=true → showWindowControls=false,右端不渲染窗口控件块。
    expect(screen.queryByLabelText('rightSidebar.tabs.controls.closeAria')).toBeNull();
  });

  it('fires onAllTabsClosed exactly once when the last tab is closed', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-a', kind: 'file-browser', state: null },
        { id: 'tab-b', kind: 'terminal', state: null },
      ],
      activeTabId: 'tab-a',
    });
    const onAllTabsClosed = vi.fn();
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onAllTabsClosed,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy(),
    );
    // 关掉第一个 → 还剩 1 个,不触发(prev>0 但 now≠0)。
    await act(async () => {
      await closeTab('s1', 'tab-a');
    });
    expect(onAllTabsClosed).not.toHaveBeenCalled();
    // 关掉最后一个 → tab 数 1→0,触发一次。
    await act(async () => {
      await closeTab('s1', 'tab-b');
    });
    expect(onAllTabsClosed).toHaveBeenCalledTimes(1);
  });

  it('does not fire onAllTabsClosed for a session that is empty from the start', async () => {
    tabsIpc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null });
    const onAllTabsClosed = vi.fn();
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onAllTabsClosed,
      }),
    );

    // hydrated 后一直是 0(从未 >0),首帧 prev===null 不触发。
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAllTabsClosed).not.toHaveBeenCalled();
  });

  it('does not fire onAllTabsClosed when switching to an empty session', async () => {
    tabsIpc.list
      .mockResolvedValueOnce({
        tabs: [{ id: 'tab-a', kind: 'file-browser', state: null }],
        activeTabId: 'tab-a',
      })
      .mockResolvedValueOnce({ tabs: [], activeTabId: null });
    const onAllTabsClosed = vi.fn();
    const { rerender } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onAllTabsClosed,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy(),
    );

    // 切到本就空的 s2:sessionId effect 把计数重置为 null,不应把"换到空 session"
    // 误判成"关掉最后一个 tab"。
    rerender(
      createElement(RightSidebarShell, {
        sessionId: 's2',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onAllTabsClosed,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAllTabsClosed).not.toHaveBeenCalled();
  });
});
