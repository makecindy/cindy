// @vitest-environment jsdom

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { AppShortcutOverrides } from '../../../../shared/appShortcuts';
import type { LucideIcon } from 'lucide-react';

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

// eagerSpawnAndReport 会真的 acquire 一个 <webview> 并等 dom-ready(jsdom 里永远
// 不来 → 8s 兜底),跨 session popup 用例只关心它前后的编排,所以桩掉这一个导出。
const eagerSpawnAndReport = vi.fn(async (_s: string, _t: string, _u: string) => undefined);
vi.mock('../lib/rsbBrowserBridge', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/rsbBrowserBridge')>('../lib/rsbBrowserBridge');
  return {
    ...actual,
    eagerSpawnAndReport: (s: string, t: string, u: string) => eagerSpawnAndReport(s, t, u),
  };
});

import { RightSidebarShell } from '../RightSidebarShell';
import { registerTabKind, unregisterTabKind } from '../registry';
import { _resetRsbBrowserBridgeForTests } from '../lib/rsbBrowserBridge';
import { _resetPopupRouterForTests } from '../lib/popupRouter';
import { _resetNativePopupTabsForTests } from '../lib/nativePopupTabs';
import {
  _resetSidebarCommandsForTests,
  onRequestRightSidebarVisibility,
  type SidebarVisibilityRequest,
  type SidebarVisibilityRequestOptions,
} from '../lib/sidebarCommands';
import { _resetStore, closeTab, getBucket, setActiveTab } from '../store';
import { writePanelCollapsed } from '@/layout/collapsePrefs';
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

interface RsbBrowserPopupPayloadStub {
  url: string;
  disposition: string;
  openerTabId?: string;
  openerSessionId?: string;
  nativePopupSurfaceId?: string;
}

let rsbBrowserPopupListeners: Array<(payload: RsbBrowserPopupPayloadStub) => void> = [];
let rsbNativePopupEventListeners: Array<(payload: { surfaceId: string; type: 'closed' }) => void> =
  [];
const rsbNativePopupClaim = vi.fn(async () => ({
  alive: true as const,
  snapshot: {
    url: 'about:blank',
    title: '',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isAudible: false,
    crash: null,
  },
}));
const rsbNativePopupClose = vi.fn(async () => ({ ok: true as const }));

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
        rsbNativePopup: {
          claim: typeof rsbNativePopupClaim;
          close: typeof rsbNativePopupClose;
          setBounds: ReturnType<typeof vi.fn>;
          command: ReturnType<typeof vi.fn>;
          onEvent: ReturnType<typeof vi.fn>;
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
    rsbNativePopup: {
      claim: rsbNativePopupClaim,
      close: rsbNativePopupClose,
      setBounds: vi.fn(async () => ({ ok: true })),
      command: vi.fn(async () => ({ ok: true })),
      onEvent: vi.fn((callback: (payload: { surfaceId: string; type: 'closed' }) => void) => {
        rsbNativePopupEventListeners.push(callback);
        return () => {
          rsbNativePopupEventListeners = rsbNativePopupEventListeners.filter(
            (cb) => cb !== callback,
          );
        };
      }),
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
    onRsbBrowserPopup: vi.fn((callback: (payload: RsbBrowserPopupPayloadStub) => void) => {
      rsbBrowserPopupListeners.push(callback);
      return () => {
        rsbBrowserPopupListeners = rsbBrowserPopupListeners.filter((cb) => cb !== callback);
      };
    }),
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
    _resetPopupRouterForTests();
    _resetNativePopupTabsForTests();
    rsbBrowserCommandListeners = [];
    rsbBrowserPopupListeners = [];
    rsbNativePopupEventListeners = [];
    rsbNativePopupClaim.mockClear();
    rsbNativePopupClose.mockClear();
    eagerSpawnAndReport.mockClear();
    eagerSpawnAndReport.mockImplementation(async () => undefined);
    tabsIpc = makeRightSidebarTabsIpc();
    installElectronApi(tabsIpc);
  });

  afterEach(() => {
    _resetStore();
    _resetRsbBrowserBridgeForTests();
    _resetPopupRouterForTests();
    _resetNativePopupTabsForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('clears the active browser session only when a visible detached shell is hidden', async () => {
    const setActiveSession = window.electronAPI.rsbBrowserBridge.setActiveSession;
    const view = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: false,
        isMac: true,
      }),
    );

    await waitFor(() => expect(tabsIpc.list).toHaveBeenCalledWith({ sessionId: 's1' }));
    expect(setActiveSession).not.toHaveBeenCalled();

    view.rerender(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
      }),
    );

    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith({ sessionId: 's1' }));

    view.rerender(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: false,
        isMac: true,
      }),
    );

    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith({ sessionId: null }));
  });

  it('mounts only the active body first, then idle-mounts and keeps the rest alive', async () => {
    const idleCallbacks: IdleRequestCallback[] = [];
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        idleCallbacks.push(callback);
        return idleCallbacks.length;
      }),
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: vi.fn(),
    });
    const mountA = vi.fn();
    const unmountA = vi.fn();
    const mountB = vi.fn();
    const unmountB = vi.fn();
    const BodyA = () => {
      useEffect(() => {
        mountA();
        return unmountA;
      }, []);
      return createElement('div', { 'data-testid': 'body-a' });
    };
    const BodyB = () => {
      useEffect(() => {
        mountB();
        return unmountB;
      }, []);
      return createElement('div', { 'data-testid': 'body-b' });
    };
    const Pill = () => createElement('span');
    const Icon = (() => null) as unknown as LucideIcon;
    registerTabKind({
      kind: 'file-browser',
      menu: {
        kind: 'file-browser',
        labelKey: 'rightSidebar.tabs.kinds.fileBrowser',
        icon: Icon,
        order: 1,
        enabled: true,
      },
      TabPillTitle: Pill,
      TabBody: BodyA,
      defaultState: () => ({}),
    });
    registerTabKind({
      kind: 'terminal',
      menu: {
        kind: 'terminal',
        labelKey: 'rightSidebar.tabs.kinds.terminal',
        icon: Icon,
        order: 2,
        enabled: true,
      },
      TabPillTitle: Pill,
      TabBody: BodyB,
      defaultState: () => ({}),
    });
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-a', kind: 'file-browser', state: null },
        { id: 'tab-b', kind: 'terminal', state: null },
      ],
      activeTabId: 'tab-a',
    });

    try {
      const view = render(
        createElement(RightSidebarShell, {
          sessionId: 's1',
          workdir: '/tmp/repo',
          remoteHostId: null,
          isMac: true,
        }),
      );

      await waitFor(() => expect(screen.getByTestId('body-a')).toBeTruthy());
      expect(screen.queryByTestId('body-b')).toBeNull();
      expect(idleCallbacks).toHaveLength(1);

      act(() => {
        idleCallbacks.shift()?.({
          didTimeout: false,
          timeRemaining: () => 50,
        });
      });

      await waitFor(() => expect(screen.getByTestId('body-b')).toBeTruthy());
      expect(screen.getByTestId('body-a')).toBeTruthy();

      await act(async () => {
        await setActiveTab('s1', 'tab-b');
      });

      expect(screen.getByTestId('body-a')).toBeTruthy();
      expect(screen.getByTestId('body-b')).toBeTruthy();
      expect(mountA).toHaveBeenCalledOnce();
      expect(mountB).toHaveBeenCalledOnce();
      expect(unmountA).not.toHaveBeenCalled();
      expect(unmountB).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      unregisterTabKind('file-browser');
      unregisterTabKind('terminal');
      delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
      delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    }
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

  it('adds a no-drag hit hole when the unified topbar is the rail ChromeActions owner', async () => {
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        railChromeActionsHitHole: true,
      }),
    );

    const topbar = await screen.findByTestId('right-sidebar-unified-topbar');
    const hitHole = screen.getByTestId('right-sidebar-rail-chrome-actions-hit-hole');
    expect(topbar.contains(hitHole)).toBe(true);
    expect(hitHole.style.width).toBe(`${CHROME_ACTIONS_GEOMETRY.clusterWidth}px`);
    expect(
      (hitHole.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    const spacer = screen.getByTestId('right-sidebar-rail-chrome-actions-spacer');
    expect(spacer.style.width).toBe(`${CHROME_ACTIONS_GEOMETRY.clusterWidth}px`);
    expect(
      (spacer.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
  });

  it('does not reserve rail ChromeActions space in fullscreen', async () => {
    installElectronApi(tabsIpc, true);
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        railChromeActionsHitHole: true,
      }),
    );

    await waitFor(() => expect(screen.getByTestId('right-sidebar-unified-topbar')).toBeTruthy());
    await waitFor(() => {
      expect(screen.queryByTestId('right-sidebar-rail-chrome-actions-hit-hole')).toBeNull();
      expect(screen.queryByTestId('right-sidebar-rail-chrome-actions-spacer')).toBeNull();
    });
  });

  it('keeps mac panel actions in the panel topbar without reserving a hidden show trigger', async () => {
    // 展开态没有固定唤起入口；detach / maximize / 收起始终属于面板自身。
    const onDetach = vi.fn();
    const onMaximize = vi.fn();
    const onCloseSidebar = vi.fn();
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
        onCloseSidebar,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    const actions = screen.getByTestId('right-sidebar-topbar-actions');
    expect(actions).toBeTruthy();
    screen.getByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' }).click();
    expect(onDetach).toHaveBeenCalledOnce();
    screen.getByRole('button', { name: 'rightSidebar.tabs.controls.maximizeAria' }).click();
    expect(onMaximize).toHaveBeenCalledOnce();
    screen.getByRole('button', { name: 'contentHeader.collapsePanel' }).click();
    expect(onCloseSidebar).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('right-sidebar-fixed-trigger-spacer')).toBeNull();
    unmount();

    // maximize 后面板占据最右边缘，仍保留自属控件，但不为隐藏的唤起入口留空。
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
        onCloseSidebar,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.getByTestId('right-sidebar-topbar-actions')).toBeTruthy();
    expect(screen.queryByTestId('right-sidebar-fixed-trigger-spacer')).toBeNull();
    unmountMax();

    // 贴右时同样保留面板自属控件，不显示无效唤起入口，也不留空。
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onDetach,
        onMaximize,
        onCloseSidebar,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.getByTestId('right-sidebar-topbar-actions')).toBeTruthy();
    expect(screen.queryByTestId('right-sidebar-fixed-trigger-spacer')).toBeNull();
    expect(screen.getByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'contentHeader.collapsePanel' })).toBeTruthy();
  });

  it('keeps the existing 36px TabBar host on Windows', async () => {
    const onCloseSidebar = vi.fn();
    const onShowSidebar = vi.fn();
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: false,
        onCloseSidebar,
        onShowSidebar,
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
    const showButton = screen.getByRole('button', {
      name: 'rightSidebar.tabs.controls.showAria',
    });
    showButton.click();
    expect(onShowSidebar).toHaveBeenCalledOnce();
    expect(showButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not render the fixed show action while the Windows sidebar is already expanded', async () => {
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: false,
        onCloseSidebar: vi.fn(),
        onMaximize: vi.fn(),
        onDetach: vi.fn(),
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.tabs.controls.showAria' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: 'rightSidebar.tabs.controls.closeAria' }),
    ).toBeTruthy();
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

describe('RightSidebarShell 跨 session popup 归属', () => {
  let tabsIpc: RightSidebarTabsIpcStub;
  let requests: Array<{
    visibility: SidebarVisibilityRequest;
    opts: SidebarVisibilityRequestOptions;
  }>;
  let unsubVisibility: () => void;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
    _resetStore();
    _resetRsbBrowserBridgeForTests();
    _resetPopupRouterForTests();
    _resetNativePopupTabsForTests();
    _resetSidebarCommandsForTests();
    rsbBrowserCommandListeners = [];
    rsbBrowserPopupListeners = [];
    rsbNativePopupEventListeners = [];
    rsbNativePopupClaim.mockClear();
    rsbNativePopupClose.mockClear();
    eagerSpawnAndReport.mockClear();
    eagerSpawnAndReport.mockImplementation(async () => undefined);
    requests = [];
    unsubVisibility = onRequestRightSidebarVisibility((visibility, opts) => {
      requests.push({ visibility, opts });
    });
    tabsIpc = makeRightSidebarTabsIpc();
    installElectronApi(tabsIpc);
  });

  afterEach(() => {
    unsubVisibility();
    _resetSidebarCommandsForTests();
    _resetStore();
    _resetRsbBrowserBridgeForTests();
    _resetPopupRouterForTests();
    _resetNativePopupTabsForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  function renderShell(): void {
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );
  }

  async function emitCrossSessionPopup(): Promise<void> {
    await waitFor(() => expect(rsbBrowserPopupListeners).toHaveLength(1));
    await act(async () => {
      rsbBrowserPopupListeners[0]({
        url: 'https://accounts.example.com/oauth',
        disposition: 'foreground-tab',
        openerTabId: 'tab-opener',
        openerSessionId: 's2',
      });
      await Promise.resolve();
    });
  }

  it('把 popup 落进 opener session,并以 userInitiated:false 请求展开', async () => {
    renderShell();
    await emitCrossSessionPopup();

    await waitFor(() => expect(getBucket('s2').tabs).toHaveLength(1));
    // 当前会话 s1 不该被塞进这个 tab。
    expect(getBucket('s1').tabs).toHaveLength(0);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].visibility).toBe('open');
    expect(requests[0].opts.sessionId).toBe('s2');
    // popup 是 guest 页面脚本催生的,不是用户手势:detached 形态下不得 show+focus
    // 抢走用户前台(与 agent tab-op open 路径一致)。
    expect(requests[0].opts.userInitiated).toBe(false);
  });

  it('native popup claim 原始 WebContents,不再 eagerSpawn 新 webview,并响应 window.close', async () => {
    renderShell();
    await waitFor(() => expect(rsbBrowserPopupListeners).toHaveLength(1));
    await act(async () => {
      rsbBrowserPopupListeners[0]({
        url: 'about:blank',
        disposition: 'foreground-tab',
        openerTabId: 'tab-opener',
        openerSessionId: 's1',
        nativePopupSurfaceId: 'surface-oauth',
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getBucket('s1').tabs).toHaveLength(1));
    const tab = getBucket('s1').tabs[0];
    await waitFor(() => expect(rsbNativePopupClaim).toHaveBeenCalledTimes(1));
    expect(rsbNativePopupClaim).toHaveBeenCalledWith({
      surfaceId: 'surface-oauth',
      sessionId: 's1',
      tabId: tab.id,
    });
    expect(tab.state).toMatchObject({
      url: 'about:blank',
      nativePopupSurfaceId: 'surface-oauth',
    });
    expect(eagerSpawnAndReport).not.toHaveBeenCalled();

    await act(async () => {
      for (const listener of rsbNativePopupEventListeners) {
        listener({ surfaceId: 'surface-oauth', type: 'closed' });
      }
      await Promise.resolve();
    });
    await waitFor(() => expect(getBucket('s1').tabs).toHaveLength(0));
    expect(rsbNativePopupClose).toHaveBeenCalledWith({ surfaceId: 'surface-oauth' });
  });

  it('Shell 卸载(route 切换)后 popup 仍被常驻 router 路由,不丢事件', async () => {
    // popup 订阅在窗口级常驻模块,不随 Shell 生命周期:用户离开聊天视图 / main
    // 端归属等待期间 route 切换,归属明确的 popup 照常落 opener session。
    const view = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );
    await waitFor(() => expect(rsbBrowserPopupListeners).toHaveLength(1));
    view.unmount();
    // 卸载后 listener 仍在(常驻订阅不解绑)。
    expect(rsbBrowserPopupListeners).toHaveLength(1);

    await act(async () => {
      rsbBrowserPopupListeners[0]({
        url: 'https://accounts.example.com/oauth',
        disposition: 'foreground-tab',
        openerTabId: 'tab-opener',
        openerSessionId: 's2',
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getBucket('s2').tabs).toHaveLength(1));
    await waitFor(() => expect(eagerSpawnAndReport).toHaveBeenCalledTimes(1));
  });

  it('无归属 popup 在 Shell 卸载后回落到最后已知 session(不丢弃)', async () => {
    const view = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
      }),
    );
    await waitFor(() => expect(rsbBrowserPopupListeners).toHaveLength(1));
    view.unmount();

    await act(async () => {
      rsbBrowserPopupListeners[0]({
        url: 'https://plain.example.com/page',
        disposition: 'foreground-tab',
        // 无 openerSessionId:回落 fallback(最后看过的 s1)。
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getBucket('s1').tabs).toHaveLength(1));
  });

  it('当前 session 的 popup 也离屏物化并请求展开(折叠侧栏下 OAuth 不再卡死)', async () => {
    // #700 之后隐藏 tab 不再首次物化:当前 session 侧栏折叠时 Shell 挂着但
    // shellVisible=false,popup tab 若只靠 TabBody 出生 webview,授权页永远不
    // 开始加载。popup 路径必须无条件 eagerSpawn,并对当前 session 发展开请求
    // (折叠时展开;已展开 no-op)。
    renderShell();
    await waitFor(() => expect(rsbBrowserPopupListeners).toHaveLength(1));
    await act(async () => {
      rsbBrowserPopupListeners[0]({
        url: 'https://accounts.example.com/oauth',
        disposition: 'foreground-tab',
        openerTabId: 'tab-opener',
        openerSessionId: 's1', // 归属就是当前 session
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(getBucket('s1').tabs).toHaveLength(1));
    await waitFor(() => expect(eagerSpawnAndReport).toHaveBeenCalledTimes(1));
    expect(eagerSpawnAndReport).toHaveBeenCalledWith(
      's1',
      getBucket('s1').tabs[0].id,
      'https://accounts.example.com/oauth',
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].visibility).toBe('open');
    expect(requests[0].opts.sessionId).toBe('s1');
    expect(requests[0].opts.userInitiated).toBe(false);
  });

  it('物化期间 tab 已被关掉时,不再请求展开(否则把"收起"翻回"展开")', async () => {
    // OAuth callback 页可能在 dom-ready 前就 window.close():guest 自关路径会关掉
    // 最后一个 tab 并请求收起侧栏,此处若无条件再请求 open,用户切回该 session
    // 只会看到一个空侧栏。
    eagerSpawnAndReport.mockImplementation(async (sessionId: string, tabId: string) => {
      await closeTab(sessionId, tabId);
    });

    renderShell();
    await emitCrossSessionPopup();

    await waitFor(() => expect(eagerSpawnAndReport).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getBucket('s2').tabs).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});
