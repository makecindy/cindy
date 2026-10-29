// @vitest-environment jsdom

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppShortcutOverrides } from '../../../../shared/appShortcuts';
import {
  BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
  BROWSER_COMMENT_EXIT_MODE_CHANNEL,
} from '../../../../shared/browserComment';
import { Globe, type LucideIcon } from 'lucide-react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId: () => undefined,
  useRemoteProjectSessions: () => [],
}));

vi.mock('../lib/openSideChatTab', () => ({
  canOpenSideChat: () => false,
  openSideChatTab: vi.fn(async () => true),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../plugins', () => ({}));

const installedGhostsMock = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  useInstalledGhosts: () => installedGhostsMock.list,
  readInstalledGhostsSnapshot: () => installedGhostsMock.list,
}));

// Real guest preload and host, joined only at the Electron IPC boundary.
const commentIpc = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  sendToHost: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) =>
      commentIpc.listeners.set(channel, listener),
    sendToHost: (channel: string, payload: unknown) => commentIpc.sendToHost(channel, payload),
  },
}));

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
import '../plugins/plugin-task';
import { BrowserTabBody } from '../plugins/web-browser/BrowserTabBody';
import type { WebBrowserState } from '../plugins/web-browser';
import type { TabKindBodyProps } from '../types';
import { browserWebviewPool } from '../lib/browserWebviewPool';
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
import {
  __resetSidebarTabWindowsStateForTest,
  __setSidebarTabWindowsStateForTest,
} from '@/lib/sidebarTabWindowState';
import {
  __resetGlobalTabsForTest,
  addGlobalPluginTab,
  getActiveGlobalTabId,
  requestRevealSessionTab,
} from '../globalTabs';
import { __resetTabGroupsForTest, getTabGroup } from '../tabGroups';
import { toast } from '@/lib/toast';
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
    __resetSidebarTabWindowsStateForTest();
    __resetGlobalTabsForTest();
    __resetTabGroupsForTest();
    window.localStorage.clear();
    installedGhostsMock.list = [];
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // 测试价值
  // - 生产入口与可观察结果:RightSidebarShell 同时投影全局页签(globalTabs,不跟对话)与任务
  //   页签;可观察的是全局页签钉在条首并带图钉、切任务后仍在、点它只改本窗口的全局激活位
  //   而不写任务桶的 setActive、有全局页签在场时任务页签关空不触发自动收起、关闭全局页签
  //   是全局动作、插件停用后它从投影里消失但数据保留。
  // - Bug / 规则依据:右侧栏「跟对话 / 不跟对话」两类页签模型(本 PR)。
  // - 现有覆盖缺口:其余用例只覆盖任务桶。
  // - 最小失败输入:一个 plugin-view 全局页签 + 一个任务页签,切换任务。
  // - tier:unit(jsdom,localStorage 全局页签 + 进程内 store)。
  it('pins global plugin-view tabs across tasks without touching the task bucket active marker', async () => {
    installedGhostsMock.list = [
      { manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html', title: 'Alpha Panel' } }, enabled: true },
    ];
    const globalTab = addGlobalPluginTab('alpha')!;
    const onAllTabsClosed = vi.fn();
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [{ id: 'tab-files', kind: 'file-browser', state: null }],
      activeTabId: 'tab-files',
    });
    const { rerender } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        subagentsAvailable: false,
        onAllTabsClosed,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy());
    const pinned = screen.getByTestId('right-sidebar-pinned-tabs');
    expect(pinned.textContent).toContain('rightSidebar.tabs.kinds.pluginView');
    expect(pinned.querySelector('[data-pinned]')).toBeTruthy();

    // 选中全局页签:只改本窗口的全局激活位,任务桶的 setActive 不落库。
    tabsIpc.setActive.mockClear();
    fireEvent.click(screen.getByText('rightSidebar.tabs.kinds.pluginView'));
    expect(getActiveGlobalTabId()).toBe(globalTab.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tabsIpc.setActive).not.toHaveBeenCalled();

    // 切到空任务:全局页签还在、仍是激活页签;任务没有页签但不渲染空态、不触发收起。
    tabsIpc.list.mockResolvedValueOnce({ tabs: [], activeTabId: null });
    rerender(
      createElement(RightSidebarShell, {
        sessionId: 's2',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        subagentsAvailable: false,
        onAllTabsClosed,
      }),
    );
    await waitFor(() => expect(getBucket('s2').hydrated).toBe(true));
    expect(screen.getByTestId('right-sidebar-pinned-tabs').textContent).toContain(
      'rightSidebar.tabs.kinds.pluginView',
    );
    expect(screen.queryByText('rightSidebar.tabs.empty.title')).toBeNull();
    expect(onAllTabsClosed).not.toHaveBeenCalled();

    // 插件停用:页签从投影消失(数据保留),没有别的页签了才算关空。
    installedGhostsMock.list = [
      { manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html', title: 'Alpha Panel' } }, enabled: false },
    ];
    rerender(
      createElement(RightSidebarShell, {
        sessionId: 's2',
        workdir: '/tmp/other',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        subagentsAvailable: false,
        onAllTabsClosed,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('right-sidebar-pinned-tabs')).toBeNull());
    expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy();
    await waitFor(() => expect(onAllTabsClosed).toHaveBeenCalledOnce());
  });

  // 测试价值
  // - 生产入口与可观察结果:同一任务的右侧组与左侧组两个 Shell;可观察的是页签右键
  //   「移到左侧」后从右侧条消失、出现在左侧条并被选中(组归属落 localStorage),在左侧
  //   组点它仍写任务级激活位;「关闭其他」只作用于本组。
  // - Bug / 规则依据:页签组模型——页签可移到聊天区任一边,两边投影同一任务桶不串。
  // - 现有覆盖缺口:Shell 此前只有单组。
  // - 最小失败输入:两个任务页签 + 一次「移到左侧」。
  // - tier:unit(jsdom,进程内 store + localStorage 组归属)。
  it('moves a task tab between groups; each group projects only its own tabs', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-files', kind: 'file-browser', state: null },
        { id: 'tab-web', kind: 'web-browser', state: null },
      ],
      activeTabId: 'tab-files',
    });
    const shellProps = {
      sessionId: 's1',
      workdir: '/tmp/repo',
      remoteHostId: null,
      isMac: false,
      subagentsAvailable: false,
    };
    const right = render(createElement(RightSidebarShell, { ...shellProps, groupId: 'right' }));
    await waitFor(() => expect(getBucket('s1').hydrated).toBe(true));
    const left = render(createElement(RightSidebarShell, { ...shellProps, groupId: 'left' }));
    const stripOf = (view: ReturnType<typeof render>) =>
      view.container.querySelector('[data-testid="right-sidebar-tab-strip"]')!;
    expect(stripOf(right).textContent).toContain('rightSidebar.tabs.kinds.browser');
    expect(stripOf(left).textContent).not.toContain('rightSidebar.tabs.kinds.browser');

    // 右键浏览器页签 →「移到左侧」。
    const webPill = right.getByText('rightSidebar.tabs.kinds.browser').closest('.group')!;
    fireEvent.contextMenu(webPill);
    fireEvent.click(screen.getByTestId('right-sidebar-tab-move-left'));
    expect(getTabGroup('tab-web')).toBe('left');
    await waitFor(() =>
      expect(stripOf(left).textContent).toContain('rightSidebar.tabs.kinds.browser'),
    );
    expect(stripOf(right).textContent).not.toContain('rightSidebar.tabs.kinds.browser');
    // 搬过去的页签在左侧组被选中并成为任务级激活页签;右侧组回落到自己剩下的页签。
    await waitFor(() => expect(getBucket('s1').activeTabId).toBe('tab-web'));
    expect(stripOf(left).querySelector('.group')?.className).toContain('font-medium');
    expect(
      right.getByText('rightSidebar.tabs.kinds.fileBrowser').closest('.group')?.className,
    ).toContain('font-medium');

    // 在右侧组点文件页签:任务级激活位照常落库。
    tabsIpc.setActive.mockClear();
    fireEvent.click(right.getByText('rightSidebar.tabs.kinds.fileBrowser'));
    await waitFor(() => expect(tabsIpc.setActive).toHaveBeenCalled());
    expect(getBucket('s1').activeTabId).toBe('tab-files');

    // 右侧组「关闭其他」只关本组的页签(本组只剩文件页签,无其它可关)。
    fireEvent.contextMenu(right.getByText('rightSidebar.tabs.kinds.fileBrowser').closest('.group')!);
    const closeOthers = screen
      .getByText('rightSidebar.tabs.contextMenu.closeOthers')
      .closest('[role="menuitem"]')!;
    expect(closeOthers.getAttribute('data-disabled')).not.toBeNull();
    left.unmount();
    right.unmount();
  });

  it.each([
    { otherBrowser: false, release: 'close', away: 'task-b' },
    { otherBrowser: true, release: 'close', away: 'task-b' },
    { otherBrowser: false, release: 'evict', away: 'task-b' },
    { otherBrowser: true, release: 'evict', away: 'task-b' },
    // New-task page without a project: the shell stays mounted with no foreground session (#6485).
    { otherBrowser: false, release: 'close', away: null },
  ])('keeps a live browser connected across task switches ($otherBrowser, away: $away) until $release', async ({ otherBrowser, release, away }) => {
    Object.assign(window.electronAPI, { onRsbBrowserFocusUrlBar: () => () => undefined });
    registerTabKind({
      kind: 'web-browser',
      menu: { kind: 'web-browser', labelKey: 'browser', icon: Globe, order: 1, enabled: true },
      TabPillTitle: () => createElement('span', null, 'browser'),
      TabBody: (props: TabKindBodyProps) => createElement(BrowserTabBody, { ...props, state: props.state as WebBrowserState }),
      defaultState: () => ({ url: 'https://example.test/', title: '', favicon: null, isAudible: false }),
    });
    const entry = browserWebviewPool.acquire('browser-a');
    // jsdom has no Electron guest APIs. Keep the real pool, hook and bodies;
    // only supply the native boundary used to observe a loaded guest.
    Object.assign(entry.webview, {
      getURL: () => 'https://example.test/',
      getTitle: () => '',
      canGoBack: () => false,
      canGoForward: () => false,
      getWebContentsId: () => 101,
      setAudioMuted: () => undefined,
      executeJavaScript: async () => undefined,
    });
    if (otherBrowser) {
      const b = browserWebviewPool.acquire('browser-b');
      Object.assign(b.webview, {
        getURL: () => 'https://other.test/', getTitle: () => '',
        canGoBack: () => false, canGoForward: () => false,
        getWebContentsId: () => 102, setAudioMuted: () => undefined,
        executeJavaScript: async () => undefined,
      });
    }
    tabsIpc.list.mockImplementation(async ({ sessionId }: { sessionId: string }) => sessionId === 'task-a' ? {
      tabs: [{ id: 'browser-a', kind: 'web-browser', state: { url: 'https://example.test/' } }],
      activeTabId: 'browser-a',
    } : otherBrowser ? {
      tabs: [{ id: 'browser-b', kind: 'web-browser', state: { url: 'https://other.test/' } }],
      activeTabId: 'browser-b',
    } : { tabs: [], activeTabId: null });
    const props = { workdir: '/tmp/task-a', remoteHostId: null, isMac: true };
    const view = render(createElement(RightSidebarShell, { ...props, sessionId: 'task-a' }));
    try {
      await waitFor(() => expect(entry.wrapper.parentElement?.id).not.toBe('browser-webview-pool'));
      const slot = entry.wrapper.parentElement!;
      expect(slot.isConnected).toBe(true);
      const removedAncestors: Node[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.removedNodes) {
          if (node.contains(entry.wrapper)) removedAncestors.push(node);
        }
      });
      observer.observe(view.container, { childList: true, subtree: true });
      for (let i = 0; i < 3; i++) {
        view.rerender(createElement(RightSidebarShell, { ...props, workdir: '/tmp/task-b', sessionId: away }));
        if (away) await waitFor(() => expect(getBucket(away).hydrated).toBe(true));
        expect(entry.wrapper.parentElement).toBe(slot);
        expect(slot.isConnected).toBe(true);
        expect(slot.closest('[aria-hidden="true"]')).not.toBeNull();
        view.rerender(createElement(RightSidebarShell, { ...props, sessionId: 'task-a' }));
        expect(entry.wrapper.parentElement).toBe(slot);
        expect(slot.closest('[aria-hidden="true"]')).toBeNull();
      }
      await act(async () => { await Promise.resolve(); });
      observer.disconnect();
      expect(removedAncestors).toHaveLength(0);
      // A's event writes to A's bucket even while B is the foreground task.
      view.rerender(createElement(RightSidebarShell, { ...props, workdir: '/tmp/task-b', sessionId: away }));
      await act(async () => {
        entry.webview.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'A in background' }));
      });
      expect(getBucket('task-a').tabs[0].state).toMatchObject({ title: 'A in background' });
      if (otherBrowser) expect(getBucket('task-b').tabs[0].state).not.toMatchObject({ title: 'A in background' });
      if (release === 'close') {
        await act(async () => { await closeTab('task-a', 'browser-a'); });
      } else {
        act(() => { for (let i = 0; i < 5; i++) browserWebviewPool.acquire('pressure-' + i); });
      }
      expect(browserWebviewPool.peek('browser-a')).toBeNull();
      expect(entry.wrapper.isConnected).toBe(false);
      expect(slot.isConnected).toBe(false);
      if (release === 'evict') {
        view.rerender(createElement(RightSidebarShell, { ...props, sessionId: 'task-a' }));
        await waitFor(() => expect(browserWebviewPool.peek('browser-a')).not.toBeNull());
        const restored = browserWebviewPool.peek('browser-a')!;
        expect(restored.wrapper).not.toBe(entry.wrapper);
        expect(restored.webview.getAttribute('src')).toBe('https://example.test/');
        expect(browserWebviewPool.inspectTabIds().length).toBeLessThanOrEqual(5);
      }
    } finally {
      view.unmount();
      browserWebviewPool.releaseAll();
      unregisterTabKind('web-browser');
    }
  });

  it.each(['task switch', 'sidebar hide'] as const)(
    'closes the retained browser More portal on %s without restoring hidden focus',
    async (transition) => {
      Object.assign(window.electronAPI, { onRsbBrowserFocusUrlBar: () => () => undefined });
      registerTabKind({
        kind: 'web-browser',
        menu: { kind: 'web-browser', labelKey: 'browser', icon: Globe, order: 1, enabled: true },
        TabPillTitle: () => createElement('span', null, 'browser'),
        TabBody: (props: TabKindBodyProps) =>
          createElement(BrowserTabBody, { ...props, state: props.state as WebBrowserState }),
        defaultState: () => ({
          url: 'https://example.test/',
          title: '',
          favicon: null,
          isAudible: false,
        }),
      });
      const entry = browserWebviewPool.acquire('browser-a');
      // Supply only the Electron boundary; the host, menu portal and focus
      // handling are real, as in the retained-browser regression above.
      Object.assign(entry.webview, {
        getURL: () => 'https://example.test/',
        getTitle: () => '',
        canGoBack: () => false,
        canGoForward: () => false,
        getWebContentsId: () => 101,
        setAudioMuted: () => undefined,
        executeJavaScript: async () => undefined,
      });
      tabsIpc.list.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
        sessionId === 'task-a'
          ? {
              tabs: [{ id: 'browser-a', kind: 'web-browser', state: { url: 'https://example.test/' } }],
              activeTabId: 'browser-a',
            }
          : { tabs: [], activeTabId: null },
      );
      const props = {
        sessionId: 'task-a',
        workdir: '/tmp/task-a',
        remoteHostId: null,
        isMac: true,
        shellVisible: true,
      };
      const view = render(createElement(RightSidebarShell, props));
      const nextTaskInput = document.createElement('input');
      document.body.append(nextTaskInput);
      try {
        await waitFor(() => expect(entry.wrapper.parentElement?.id).not.toBe('browser-webview-pool'));
        const slot = entry.wrapper.parentElement;
        let trigger = screen.getByRole('button', { name: 'rightSidebar.browser.moreTools' });
        act(() => trigger.focus());
        fireEvent.keyDown(trigger, { key: 'Enter' });
        const firstMenu = await screen.findByRole('menu');
        expect(view.container.contains(firstMenu)).toBe(false);
        fireEvent.keyDown(firstMenu, { key: 'Escape' });
        await waitFor(() => expect(firstMenu.isConnected).toBe(false));
        await waitFor(() => expect(document.activeElement).toBe(trigger));

        fireEvent.keyDown(trigger, { key: 'Enter' });
        const menu = await screen.findByRole('menu');
        // Change the task without a pointer event that could independently
        // dismiss the menu, matching keyboard task switching.
        view.rerender(createElement(
          RightSidebarShell,
          transition === 'task switch'
            ? { ...props, sessionId: 'task-b', workdir: '/tmp/task-b' }
            : { ...props, shellVisible: false },
        ));
        act(() => nextTaskInput.focus());
        await waitFor(() => expect(menu.isConnected).toBe(false));
        // Radix defers close autofocus with a zero-delay timer. Drain that
        // callback before checking that the hidden opener cannot steal focus.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.activeElement).toBe(nextTaskInput);
        expect(entry.wrapper.parentElement).toBe(slot);
        expect(entry.wrapper.isConnected).toBe(true);

        view.rerender(createElement(RightSidebarShell, props));
        trigger = screen.getByRole('button', { name: 'rightSidebar.browser.moreTools' });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger.getAttribute('data-state')).toBe('closed');
        expect(entry.wrapper.parentElement).toBe(slot);
        fireEvent.keyDown(trigger, { key: 'Enter' });
        expect(await screen.findByRole('menu')).toBeTruthy();
      } finally {
        view.unmount();
        nextTaskInput.remove();
        browserWebviewPool.releaseAll();
        unregisterTabKind('web-browser');
      }
    },
  );

  function renderInteractionBrowser() {
    Object.assign(window.electronAPI, { onRsbBrowserFocusUrlBar: () => () => undefined });
    registerTabKind({
      kind: 'web-browser',
      menu: { kind: 'web-browser', labelKey: 'browser', icon: Globe, order: 1, enabled: true },
      TabPillTitle: () => createElement('span', null, 'browser'),
      TabBody: (props: TabKindBodyProps) =>
        createElement(BrowserTabBody, { ...props, state: props.state as WebBrowserState }),
      defaultState: () => ({ url: 'https://example.test/', title: '', favicon: null, isAudible: false }),
    });
    const entry = browserWebviewPool.acquire('browser-a');
    Object.assign(entry.webview, {
      getURL: () => 'https://example.test/', getTitle: () => '',
      canGoBack: () => false, canGoForward: () => false,
      getWebContentsId: () => 101, setAudioMuted: () => undefined,
      executeJavaScript: async () => undefined,
    });
    tabsIpc.list.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'task-a'
        ? { tabs: [{ id: 'browser-a', kind: 'web-browser', state: { url: 'https://example.test/' } }], activeTabId: 'browser-a' }
        : { tabs: [], activeTabId: null },
    );
    const props = { sessionId: 'task-a', workdir: '/tmp/task-a', remoteHostId: null, isMac: true, shellVisible: true };
    const view = render(createElement(RightSidebarShell, props));
    const hide = (transition: 'task switch' | 'sidebar hide') => view.rerender(createElement(
      RightSidebarShell, transition === 'task switch'
        ? { ...props, sessionId: 'task-b', workdir: '/tmp/task-b' }
        : { ...props, shellVisible: false },
    ));
    const show = () => view.rerender(createElement(RightSidebarShell, props));
    return { entry, view, hide, show };
  }

  it.each(['task switch', 'sidebar hide'] as const)(
    'cancels retained address editing on %s without background navigation', async (transition) => {
      const { entry, view, hide, show } = renderInteractionBrowser();
      const external = document.createElement('input');
      document.body.append(external);
      try {
        await screen.findByRole('button', { name: 'https://example.test/' });
        const slot = entry.wrapper.parentElement;
        const originalSrc = entry.webview.getAttribute('src');
        fireEvent.click(screen.getByRole('button', { name: 'https://example.test/' }));
        const address = view.container.querySelector('input')!;
        await waitFor(() => expect(document.activeElement).toBe(address));
        fireEvent.change(address, { target: { value: 'https://unfinished.test/' } });
        hide(transition);
        // The real Shell transition must cancel editing by itself. jsdom does
        // not implement CSS-induced blur; native blur timing needs Chromium.
        expect(view.container.querySelector('input')).toBeNull();
        expect(getBucket('task-a').tabs[0].state).toMatchObject({ url: 'https://example.test/' });
        expect(entry.webview.getAttribute('src')).toBe(originalSrc);
        show();
        expect(view.container.querySelector('input')).toBeNull();
        expect(entry.wrapper.parentElement).toBe(slot);
        expect(entry.wrapper.isConnected).toBe(true);

        // Ordinary visible blur and explicit Enter/Ctrl+Enter remain commits.
        for (const [value, key, want] of [
          ['https://clicked.test/', 'blur', 'https://clicked.test/'],
          ['https://entered.test/', 'Enter', 'https://entered.test/'],
          ['google', 'Ctrl+Enter', 'https://www.google.com'],
        ]) {
          fireEvent.click(screen.getByRole('button', { name: (getBucket('task-a').tabs[0].state as WebBrowserState).url }));
          const input = view.container.querySelector('input')!;
          await waitFor(() => expect(document.activeElement).toBe(input));
          fireEvent.change(input, { target: { value } });
          if (key === 'blur') act(() => external.focus());
          else fireEvent.keyDown(input, { key: 'Enter', ctrlKey: key === 'Ctrl+Enter' });
          expect(getBucket('task-a').tabs[0].state).toMatchObject({ url: want });
          expect(entry.webview.getAttribute('src')).toBe(want);
        }
      } finally {
        view.unmount(); external.remove();
        browserWebviewPool.releaseAll(); unregisterTabKind('web-browser');
      }
    },
  );

  it.each(['task switch', 'sidebar hide'] as const)(
    'removes the real guest comment blocker on %s while retaining its host', async (transition) => {
      await import('../../../../preload/browserCommentPreload');
      let overlay: ShadowRoot | undefined;
      const attachShadow = Element.prototype.attachShadow;
      const shadowSpy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
        const shadow = attachShadow.call(this, init);
        if (init.mode === 'closed') overlay = shadow;
        return shadow;
      });
      const target = document.createElement('button');
      target.textContent = 'Guest target';
      document.body.append(target);
      const oldHitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');
      Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [target] });
      const { entry, view, hide, show } = renderInteractionBrowser();
      Object.assign(entry.webview, { send: (channel: string, envelope: unknown) => {
        const handler = commentIpc.listeners.get(channel);
        if (!handler) throw new Error('Missing guest command: ' + channel);
        handler({}, envelope);
      } });
      commentIpc.sendToHost.mockImplementation((channel: string, payload: unknown) => {
        entry.webview.dispatchEvent(Object.assign(new Event('ipc-message'), { channel, args: [payload] }));
      });
      try {
        await screen.findByRole('button', { name: 'https://example.test/' });
        const slot = entry.wrapper.parentElement;
        const src = entry.webview.getAttribute('src');
        fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.comment' }));
        await screen.findByText('rightSidebar.browser.commentModeHint');
        const blocker = overlay!.querySelector<HTMLElement>('.blocker')!;
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
        fireEvent(blocker, click);
        expect(click.defaultPrevented).toBe(true);
        const editor = await screen.findByPlaceholderText('rightSidebar.browser.commentPlaceholder');
        fireEvent.change(editor, { target: { value: 'Keep my unfinished comment' } });
        const selectionMessage = commentIpc.sendToHost.mock.calls.find(
          ([channel]) => channel === BROWSER_COMMENT_ELEMENT_SELECTED_CHANNEL,
        )!;
        hide(transition);
        await waitFor(() => expect(blocker.isConnected).toBe(false));
        // A queued selection from the old interaction must not reopen an
        // editor in the retained background host.
        act(() => commentIpc.sendToHost(...selectionMessage));
        expect(screen.queryByPlaceholderText('rightSidebar.browser.commentPlaceholder')).toBeNull();
        // Detached old blocker must have lost its capture handler as well.
        const staleClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        fireEvent(blocker, staleClick);
        expect(staleClick.defaultPrevented).toBe(false);
        expect(entry.wrapper.parentElement).toBe(slot);
        expect(entry.wrapper.isConnected).toBe(true);
        expect(entry.webview.getAttribute('src')).toBe(src);
        show();
        expect(screen.queryByRole('button', { name: 'rightSidebar.browser.exitCommentMode' })).toBeNull();
        expect(screen.queryByPlaceholderText('rightSidebar.browser.commentPlaceholder')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.comment' }));
        await screen.findByText('rightSidebar.browser.commentModeHint');
        fireEvent.click(overlay!.querySelector('.blocker')!, { clientX: 20, clientY: 30 });
        expect((await screen.findByPlaceholderText('rightSidebar.browser.commentPlaceholder') as HTMLTextAreaElement).value).toBe('Keep my unfinished comment');
      } finally {
        view.unmount();
        // Real preload teardown also runs after a failed red assertion.
        commentIpc.listeners.get(BROWSER_COMMENT_EXIT_MODE_CHANNEL)?.({}, { requestId: 'test-cleanup' });
        commentIpc.sendToHost.mockReset();
        shadowSpy.mockRestore(); target.remove();
        if (oldHitTest) Object.defineProperty(document, 'elementsFromPoint', oldHitTest);
        else Reflect.deleteProperty(document, 'elementsFromPoint');
        browserWebviewPool.releaseAll(); unregisterTabKind('web-browser');
      }
    },
  );

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

  it('hides a persisted Subagents-only sidebar for non-Pi tasks without deleting the tab', async () => {
    const onAllTabsClosed = vi.fn();
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [{ id: 'tab-subagents', kind: 'subagents', state: null }],
      activeTabId: 'tab-subagents',
    });

    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
        subagentsAvailable: false,
        onAllTabsClosed,
      }),
    );

    await waitFor(() => expect(onAllTabsClosed).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('rightSidebar.tabs.kinds.subagents')).toBeNull();
    expect(tabsIpc.close).not.toHaveBeenCalled();
    expect(tabsIpc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: null });
  });

  it('collapses an unavailable retired-only sidebar without deleting its history', async () => {
    const onAllTabsClosed = vi.fn();
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [{ id: 'old-simulator', kind: 'ios-simulator', state: null }],
      activeTabId: 'old-simulator',
    });
    const view = render(createElement(RightSidebarShell, {
      sessionId: 's1', workdir: '/tmp/repo', remoteHostId: null,
      shellVisible: true, isMac: true, subagentsAvailable: false, onAllTabsClosed,
    }));
    await waitFor(() => expect(onAllTabsClosed).toHaveBeenCalledTimes(1));
    expect(tabsIpc.close).not.toHaveBeenCalled();
    expect(getBucket('s1').tabs.map(tab => tab.id)).toEqual(['old-simulator']);
    view.unmount();
  });

  // #6861:冷启动归属未知不能收起插件任务页或改写恢复的选择;正文只在确认本机后加载。
  // 真实 Shell → 可用性投影 → plugin-task → GhostWebviewBody;旧覆盖只测已解析的清单。
  // 最小输入:持久化任务页 + undefined→null/远端;另带普通页检测选中位丢失。tier:unit。
  it.each([
    { device: null, mixed: false }, { device: 'other-device', mixed: false },
    { device: null, mixed: true }, { device: 'other-device', mixed: true },
  ])('preserves plugin task selection until ownership resolves ($device, mixed=$mixed)', async ({ device, mixed }) => {
    installedGhostsMock.list = [{
      manifest: { id: 'alpha', name: 'Alpha', taskView: { html: 'task.html', title: 'Task Page' } },
      enabled: true, dir: '/tmp/alpha',
    }];
    const onAllTabsClosed = vi.fn();
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        ...(mixed ? [{ id: 'files', kind: 'file-browser', state: null }] : []),
        { id: 'plugin-task', kind: 'plugin-task', state: { instanceId: 'alpha' } },
      ], activeTabId: 'plugin-task',
    });
    const props = {
      sessionId: 's1', workdir: '/tmp/repo', remoteHostId: null, isMac: true, onAllTabsClosed,
    };
    const view = render(createElement(RightSidebarShell, props));
    await waitFor(() => expect(getBucket('s1').hydrated).toBe(true));
    expect(screen.getByText('Task Page')).toBeTruthy();
    expect(onAllTabsClosed).not.toHaveBeenCalled();
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
    expect(document.querySelector('webview')).toBeNull();
    view.rerender(createElement(RightSidebarShell, { ...props, deviceLinkDeviceId: device }));
    if (device === null) {
      await waitFor(() => expect(document.querySelector('webview')?.getAttribute('src')).toBe('cindy-ghost://alpha/task.html?session=s1'));
      expect(getBucket('s1').activeTabId).toBe('plugin-task');
      expect(onAllTabsClosed).not.toHaveBeenCalled();
      expect(tabsIpc.setActive).not.toHaveBeenCalled();
    } else {
      await waitFor(() => expect(screen.queryByText('Task Page')).toBeNull());
      expect(document.querySelector('webview')).toBeNull();
      expect(onAllTabsClosed).toHaveBeenCalledTimes(mixed ? 0 : 1);
    }
    expect(tabsIpc.close).not.toHaveBeenCalled();
  });

  it('keeps a persisted Subagents-only sidebar intact while Pi eligibility is loading', async () => {
    const onAllTabsClosed = vi.fn();
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [{ id: 'tab-subagents', kind: 'subagents', state: null }],
      activeTabId: 'tab-subagents',
    });

    const view = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
        onAllTabsClosed,
      }),
    );

    await waitFor(() => expect(tabsIpc.list).toHaveBeenCalledWith({ sessionId: 's1' }));
    expect(onAllTabsClosed).not.toHaveBeenCalled();
    // Unknown eligibility keeps the persisted projection rather than folding to
    // "unavailable" — otherwise the reconciliation below persists a different
    // active tab and the restored selection is lost before Pi resolves.
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.kinds.subagents')).toBeTruthy());
    // Nothing may be written back while the projection is provisional.
    expect(tabsIpc.setActive).not.toHaveBeenCalled();

    view.rerender(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
        subagentsAvailable: true,
        onAllTabsClosed,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.kinds.subagents')).toBeTruthy());
    expect(onAllTabsClosed).not.toHaveBeenCalled();
    expect(tabsIpc.close).not.toHaveBeenCalled();
    // The restored active marker survived the unknown window untouched.
    expect(getBucket('s1').activeTabId).toBe('tab-subagents');
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
  });

  it('keeps the restored active Subagents tab when eligibility resolves after a mixed-tab cold load', async () => {
    // Cold load: the persisted active tab is Subagents and a second, always
    // eligible tab exists. Folding unknown eligibility into "unavailable" made
    // the projection pick the file tab and persist it as active, so the user's
    // restored selection was gone by the time Pi eligibility arrived.
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-files', kind: 'file-browser', state: null },
        { id: 'tab-subagents', kind: 'subagents', state: null },
      ],
      activeTabId: 'tab-subagents',
    });

    const view = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
      }),
    );

    await waitFor(() => expect(tabsIpc.list).toHaveBeenCalledWith({ sessionId: 's1' }));
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
    expect(getBucket('s1').activeTabId).toBe('tab-subagents');

    view.rerender(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
        subagentsAvailable: true,
      }),
    );

    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.kinds.subagents')).toBeTruthy());
    expect(getBucket('s1').activeTabId).toBe('tab-subagents');
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
  });

  it('still reconciles the active marker once eligibility resolves to unavailable', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-files', kind: 'file-browser', state: null },
        { id: 'tab-subagents', kind: 'subagents', state: null },
      ],
      activeTabId: 'tab-subagents',
    });

    const view = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
      }),
    );

    await waitFor(() => expect(tabsIpc.list).toHaveBeenCalledWith({ sessionId: 's1' }));

    view.rerender(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
        subagentsAvailable: false,
      }),
    );

    await waitFor(() =>
      expect(tabsIpc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: 'tab-files' }),
    );
    expect(screen.queryByText('rightSidebar.tabs.kinds.subagents')).toBeNull();
    expect(tabsIpc.close).not.toHaveBeenCalled();
  });

  it('mounts only the active body first, then idle-mounts and keeps the rest alive', async () => {
    const idleCallbacks: Array<{ id: number; callback: IdleRequestCallback }> = [];
    let nextIdleCallbackId = 0;
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn((callback: IdleRequestCallback) => {
        const id = ++nextIdleCallbackId;
        idleCallbacks.push({ id, callback });
        return id;
      }),
    });
    Object.defineProperty(window, 'cancelIdleCallback', {
      configurable: true,
      value: vi.fn((id: number) => {
        const index = idleCallbacks.findIndex((entry) => entry.id === id);
        if (index >= 0) idleCallbacks.splice(index, 1);
      }),
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
        idleCallbacks.shift()?.callback({
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
    // 「在独立窗口中打开」作用于当前页签:有激活页签时才渲染,回调带该页签 id。
    const onDetachTab = vi.fn();
    const onMaximize = vi.fn();
    const onCloseSidebar = vi.fn();
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [{ id: 'tab-pop', kind: 'file-browser', state: null }],
      activeTabId: 'tab-pop',
    });
    const { unmount } = render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        panelSide: 'left',
        onDetachTab,
        onMaximize,
        onCloseSidebar,
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' }),
      ).toBeTruthy(),
    );
    const actions = screen.getByTestId('right-sidebar-topbar-actions');
    expect(actions).toBeTruthy();
    screen.getByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' }).click();
    expect(onDetachTab).toHaveBeenCalledWith('tab-pop');
    screen.getByRole('button', { name: 'rightSidebar.tabs.controls.maximizeAria' }).click();
    expect(onMaximize).toHaveBeenCalledOnce();
    screen.getByRole('button', { name: 'contentHeader.collapsePanel' }).click();
    expect(onCloseSidebar).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('right-sidebar-fixed-trigger-spacer')).toBeNull();
    unmount();
    // 后两次渲染回到空会话(store 是模块级单例,先清掉上面水合进来的页签)。
    _resetStore();

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
        onDetachTab,
        onMaximize,
        onCloseSidebar,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.getByTestId('right-sidebar-topbar-actions')).toBeTruthy();
    expect(screen.queryByTestId('right-sidebar-fixed-trigger-spacer')).toBeNull();
    // 没有页签就没有可弹出的目标:按钮不渲染。
    expect(
      screen.queryByRole('button', { name: 'rightSidebar.tabs.controls.detachAria' }),
    ).toBeNull();
    unmountMax();

    // 贴右时同样保留面板自属控件，不显示无效唤起入口，也不留空。
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        isMac: true,
        unifiedTopbar: true,
        onDetachTab,
        onMaximize,
        onCloseSidebar,
      }),
    );
    await waitFor(() => expect(screen.getByText('rightSidebar.tabs.empty.title')).toBeTruthy());
    expect(screen.getByTestId('right-sidebar-topbar-actions')).toBeTruthy();
    expect(screen.queryByTestId('right-sidebar-fixed-trigger-spacer')).toBeNull();
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
        onDetachTab: vi.fn(),
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
        onDetachTab: vi.fn(),
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

  // 测试价值
  // - 生产入口与可观察结果:RightSidebarShell 渲染同一会话桶;页签弹出到独立窗口
  //   (sidebarTabWindowState 镜像)后主窗侧栏不再显示它的 pill 与 body,激活位落到
  //   仍在侧栏的页签并落库;窗口关闭(镜像清空)后 pill 回来。弹出窗口自身
  //   (hostedTabIds)只挂被指派的页签、不画空态、不写任务级激活位。
  // - Bug / 规则依据:侧栏「弹出」从整栏改为单页签(本 PR);webview / 终端不能双实例,
  //   两个 renderer 投影同一页签就是双实例。
  // - 现有覆盖缺口:相邻用例只覆盖可用性过滤(subagents / retired),没有跨窗口归属。
  // - 最小失败输入:两页签会话 + 镜像标记 active 页签已弹出。
  // - tier:unit(jsdom,进程内 store 与镜像,无 IPC)。
  // #6861 同族回归:弹出请求不得清空主窗全局选择;归还后同一请求才露出任务页。
  // 真实 Shell + 页签镜像交错弹出/归还,补齐独立窗口选中用例缺少的主窗半边;unit。
  it('reveals a task tab only while the attached shell hosts it', async () => {
    installedGhostsMock.list = [
      { manifest: { id: 'alpha', name: 'Alpha', panel: { html: 'p.html', title: 'Alpha Panel' } }, enabled: true },
    ];
    const globalTab = addGlobalPluginTab('alpha')!;
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-files', kind: 'file-browser', state: null },
        { id: 'tab-web', kind: 'web-browser', state: null },
      ],
      activeTabId: 'tab-files',
    });
    __setSidebarTabWindowsStateForTest({
      'tab-web': { windowId: 'w1', sessionId: 's1', open: true },
    });
    render(createElement(RightSidebarShell, {
      sessionId: 's1', workdir: '/tmp/repo', remoteHostId: null, isMac: true,
      unifiedTopbar: true,
    }));
    await waitFor(() => expect(getBucket('s1').hydrated).toBe(true));
    fireEvent.click(screen.getByText('rightSidebar.tabs.kinds.pluginView'));
    expect(getActiveGlobalTabId()).toBe(globalTab.id);
    act(() => requestRevealSessionTab('s1', 'tab-web'));
    expect(getActiveGlobalTabId()).toBe(globalTab.id);
    act(() => __setSidebarTabWindowsStateForTest({}));
    await waitFor(() => expect(document.querySelector('[data-sortable-id="tab-web"]')).toBeTruthy());
    act(() => requestRevealSessionTab('s1', 'tab-web'));
    expect(getActiveGlobalTabId()).toBeNull();
  });

  // 独立窗口多页签时，main 转来的 reveal 必须改变窗口内部激活位，不写主窗的任务桶。
  it('selects only hosted tabs when a popped-out window receives a reveal request', async () => {
    tabsIpc.list.mockResolvedValueOnce({
      tabs: [
        { id: 'tab-files', kind: 'file-browser', state: null },
        { id: 'tab-web', kind: 'web-browser', state: null },
      ],
      activeTabId: 'tab-files',
    });
    const selected = vi.fn();
    render(createElement(RightSidebarShell, {
      sessionId: 's1', workdir: '/tmp/repo', remoteHostId: null, isMac: true,
      hostedTabIds: new Set(['tab-files', 'tab-web']), onActiveTabChange: selected,
    }));
    await waitFor(() => expect(selected).toHaveBeenLastCalledWith('tab-web'));
    tabsIpc.setActive.mockClear();
    act(() => requestRevealSessionTab('s1', 'tab-files'));
    await waitFor(() => expect(selected).toHaveBeenLastCalledWith('tab-files'));
    act(() => requestRevealSessionTab('s1', 'foreign-tab'));
    expect(selected).toHaveBeenLastCalledWith('tab-files');
    expect(tabsIpc.setActive).not.toHaveBeenCalled();
  });

  it('hides popped-out tabs from the sidebar and keeps the solo window on its own tab', async () => {
    registerTabKind({
      kind: 'terminal',
      menu: { kind: 'terminal', labelKey: 'terminal', icon: Globe, order: 2, enabled: true },
      TabPillTitle: () => createElement('span', null, 'terminal-pill'),
      TabBody: () => createElement('div', null, 'terminal-body'),
      defaultState: () => ({}),
    });
    try {
      tabsIpc.list.mockResolvedValue({
        tabs: [
          { id: 'tab-files', kind: 'file-browser', state: null },
          { id: 'tab-term', kind: 'terminal', state: {} },
        ],
        activeTabId: 'tab-term',
      });
      const { unmount } = render(
        createElement(RightSidebarShell, {
          sessionId: 's1',
          workdir: '/tmp/repo',
          remoteHostId: null,
          isMac: true,
          unifiedTopbar: true,
          subagentsAvailable: false,
        }),
      );
      await waitFor(() => expect(screen.getByText('terminal-pill')).toBeTruthy());
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy();

      // 终端页签弹出:侧栏不再显示它,激活位移到文件页签并落库。
      act(() => {
        __setSidebarTabWindowsStateForTest({
          'tab-term': { windowId: 'w1', sessionId: 's1', open: true },
        });
      });
      await waitFor(() => expect(screen.queryByText('terminal-pill')).toBeNull());
      expect(screen.queryByText('terminal-body')).toBeNull();
      expect(screen.getByText('rightSidebar.tabs.kinds.fileBrowser')).toBeTruthy();
      await waitFor(() =>
        expect(tabsIpc.setActive).toHaveBeenCalledWith({ sessionId: 's1', id: 'tab-files' }),
      );
      expect(getBucket('s1').tabs).toHaveLength(2);

      // 窗口关闭(镜像清空):页签回到侧栏。
      act(() => {
        __setSidebarTabWindowsStateForTest({});
      });
      await waitFor(() => expect(screen.getByText('terminal-pill')).toBeTruthy());
      unmount();

      // 弹出窗口自身:只挂被指派的页签(页签条照常,供多页签切换),没有空态,不改任务级激活位。
      tabsIpc.setActive.mockClear();
      _resetStore();
      render(
        createElement(RightSidebarShell, {
          sessionId: 's1',
          workdir: '/tmp/repo',
          remoteHostId: null,
          isMac: true,
          subagentsAvailable: false,
          hostedTabIds: new Set(['tab-term']),
        }),
      );
      await waitFor(() => expect(screen.getByText('terminal-body')).toBeTruthy());
      expect(screen.getByTestId('right-sidebar-tab-bar')).toBeTruthy();
      expect(screen.getByText('terminal-pill')).toBeTruthy();
      expect(screen.queryByText('rightSidebar.tabs.empty.title')).toBeNull();
      expect(screen.queryByText('rightSidebar.tabs.kinds.fileBrowser')).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tabsIpc.setActive).not.toHaveBeenCalled();
    } finally {
      unregisterTabKind('terminal');
    }
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

describe('RightSidebarShell add-tab failure toast', () => {
  const toastError = vi.mocked(toast.error);
  let tabsIpc: RightSidebarTabsIpcStub;

  beforeEach(() => {
    toastError.mockClear();
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
    tabsIpc = makeRightSidebarTabsIpc();
    installElectronApi(tabsIpc);
  });

  afterEach(() => {
    _resetSidebarCommandsForTests();
    _resetStore();
    _resetRsbBrowserBridgeForTests();
    _resetPopupRouterForTests();
    _resetNativePopupTabsForTests();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  function renderShellWithTerminalKind(): void {
    registerTabKind({
      kind: 'terminal',
      menu: {
        kind: 'terminal',
        labelKey: 'rightSidebar.tabs.kinds.terminal',
        icon: (() => null) as unknown as LucideIcon,
        order: 1,
        enabled: true,
      },
      TabPillTitle: () => createElement('span'),
      TabBody: () => createElement('div'),
      defaultState: () => null,
    });
    render(
      createElement(RightSidebarShell, {
        sessionId: 's1',
        workdir: '/tmp/repo',
        remoteHostId: null,
        shellVisible: true,
        isMac: true,
      }),
    );
  }

  it.each([
    ['RIGHT_SIDEBAR_TOO_MANY_TABS', 'ipcError.RIGHT_SIDEBAR_TOO_MANY_TABS'],
    ['RIGHT_SIDEBAR_STATE_TOO_LARGE', 'ipcError.RIGHT_SIDEBAR_STATE_TOO_LARGE'],
    ['RIGHT_SIDEBAR_UNKNOWN_KIND', 'ipcError.RIGHT_SIDEBAR_UNKNOWN_KIND'],
  ])('toasts the %s message when addTab fails', async (code, expectedKey) => {
    tabsIpc.upsert.mockRejectedValueOnce(new Error(`[${code}] tab rejected`));
    try {
      renderShellWithTerminalKind();
      await waitFor(() => expect(tabsIpc.list).toHaveBeenCalledWith({ sessionId: 's1' }));
      const addButton = screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' });
      vi.spyOn(addButton.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue({
        x: 20,
        y: 20,
        top: 20,
        right: 44,
        bottom: 44,
        left: 20,
        width: 24,
        height: 24,
        toJSON: () => ({}),
      });
      fireEvent.pointerDown(addButton, { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByRole('menuitem', { name: 'rightSidebar.tabs.kinds.terminal' }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(expectedKey));
    } finally {
      unregisterTabKind('terminal');
    }
  });

  it('falls back to the generic addFailed toast for uncoded errors', async () => {
    tabsIpc.upsert.mockRejectedValueOnce(new Error('boom'));
    try {
      renderShellWithTerminalKind();
      await waitFor(() => expect(tabsIpc.list).toHaveBeenCalledWith({ sessionId: 's1' }));
      const addButton = screen.getByRole('button', { name: 'rightSidebar.tabs.addAria' });
      vi.spyOn(addButton.parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue({
        x: 20,
        y: 20,
        top: 20,
        right: 44,
        bottom: 44,
        left: 20,
        width: 24,
        height: 24,
        toJSON: () => ({}),
      });
      fireEvent.pointerDown(addButton, { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByRole('menuitem', { name: 'rightSidebar.tabs.kinds.terminal' }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith('rightSidebar.tabs.addFailed'));
    } finally {
      unregisterTabKind('terminal');
    }
  });
});
