// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import type { WebviewTag } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseBrowserWebviewResult } from '../../../hooks/useBrowserWebview';
import type { TabKindHostContext } from '../../../types';
import { BrowserTabBody } from '../BrowserTabBody';
import { useLocalHtmlAutoReload } from '../useLocalHtmlAutoReload';

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

const browserNavigate = vi.fn();
let browserState: UseBrowserWebviewResult;

const poolMocks = vi.hoisted(() => ({
  currentWrapper: null as HTMLDivElement | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/toast', () => ({ toast: toastMocks }));

vi.mock('@/components/ui/dropdown-menu', () => {
  const react = require('react') as typeof import('react');
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      react.createElement(react.Fragment, null, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      react.createElement('div', null, children),
    DropdownMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) =>
      react.createElement(
        'button',
        { type: 'button', disabled, onClick: () => onSelect?.() },
        children,
      ),
  };
});

vi.mock('../../../hooks/useBrowserWebview', () => ({
  useBrowserWebview: () => browserState,
}));

vi.mock('../useLocalHtmlAutoReload', () => ({
  useLocalHtmlAutoReload: vi.fn(),
}));

vi.mock('../../../lib/browserWebviewPool', () => ({
  browserWebviewPool: {
    release: vi.fn(),
    // Navigation tests do not create a real WebView. The wrapper is only used
    // to verify that layout cleanup respects the current Pool generation.
    peek: vi.fn(() => poolMocks.currentWrapper
      ? { wrapper: poolMocks.currentWrapper, webview: null }
      : null),
  },
}));

// 稳定的 wrapper 元素:BrowserTabBody 的首次导航按 wrapper 代际判定(淘汰后
// 重建需要重新导航),测试里跨 rerender 复用同一个元素,行为与"每 tab 一次"
// 的旧语义一致。
const sharedWrapper = document.createElement('div');

function makeBrowserState(
  patch: Partial<UseBrowserWebviewResult> = {},
): UseBrowserWebviewResult {
  return {
    wrapper: sharedWrapper,
    webview: null,
    url: 'https://www.taptap.cn/',
    title: '',
    favicon: '',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isAudible: false,
    crash: null,
    resourceAlert: null,
    navigate: browserNavigate,
    reload: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    stop: vi.fn(),
    dismissResourceAlert: vi.fn(),
    ...patch,
  };
}

function renderBrowserTab(
  stateUrl: string,
  patchState = vi.fn(),
  active = true,
  statePatch: Partial<{
    title: string;
    favicon: string | null;
    isAudible: boolean;
  }> = {},
  deviceLinkDeviceId?: string | null,
): ReactElement {
  // Omitted fifth arg models the confirmed-local default; an explicit undefined
  // models the unresolved bootstrap/cache state under test.
  const resolvedDeviceLinkDeviceId = arguments.length >= 5 ? deviceLinkDeviceId : null;
  const ctx: TabKindHostContext = {
    tabId: 'tab-browser',
    sessionId: 'session-a',
    workdir: 'C:/repo',
    remoteHostId: null,
    deviceLinkDeviceId: resolvedDeviceLinkDeviceId,
    patchState,
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => () => undefined),
  };
  return createElement(BrowserTabBody, {
    active,
    ctx,
    state: {
      url: stateUrl,
      title: '',
      favicon: null,
      isAudible: false,
      ...statePatch,
    },
  });
}

describe('BrowserTabBody navigation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        openExternal: vi.fn().mockResolvedValue({ success: true }),
        openFileInBrowser: vi.fn().mockResolvedValue({ success: true }),
        onRsbBrowserFocusUrlBar: vi.fn(() => vi.fn()),
        onRsbBrowserCommand: vi.fn(() => vi.fn()),
      },
    });
  });

  afterEach(() => {
    cleanup();
    poolMocks.currentWrapper = null;
    document.getElementById('browser-webview-pool')?.remove();
    vi.clearAllMocks();
    toastMocks.error.mockReset();
    toastMocks.success.mockReset();
    browserState = makeBrowserState();
  });

  it('keeps an eagerly created hidden wrapper parked without navigating', () => {
    const parking = document.createElement('div');
    parking.id = 'browser-webview-pool';
    document.body.appendChild(parking);
    parking.appendChild(sharedWrapper);
    poolMocks.currentWrapper = sharedWrapper;
    browserState = makeBrowserState({ wrapper: sharedWrapper, url: '' });

    const view = render(renderBrowserTab('https://example.com/persisted', vi.fn(), false));

    expect(sharedWrapper.parentElement).toBe(parking);
    expect(browserNavigate).not.toHaveBeenCalled();

    view.rerender(renderBrowserTab('https://example.com/persisted', vi.fn(), true));

    expect(sharedWrapper.parentElement).not.toBe(parking);
    expect(browserNavigate).toHaveBeenCalledOnce();
    expect(browserNavigate).toHaveBeenCalledWith('https://example.com/persisted');
  });

  it('does not reconnect a released wrapper when a replacement arrives', () => {
    const parking = document.createElement('div');
    parking.id = 'browser-webview-pool';
    document.body.appendChild(parking);
    parking.appendChild(sharedWrapper);
    poolMocks.currentWrapper = sharedWrapper;
    browserState = makeBrowserState({ wrapper: sharedWrapper });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.taptap.cn/', patchState));

    expect(sharedWrapper.isConnected).toBe(true);
    poolMocks.currentWrapper = null;
    sharedWrapper.remove();
    browserState = makeBrowserState({ wrapper: null });
    view.rerender(renderBrowserTab('https://www.taptap.cn/', patchState));

    const replacement = document.createElement('div');
    parking.appendChild(replacement);
    poolMocks.currentWrapper = replacement;
    browserState = makeBrowserState({ wrapper: replacement, url: '' });
    view.rerender(renderBrowserTab('https://www.taptap.cn/', patchState));

    expect(sharedWrapper.isConnected).toBe(false);
    expect(replacement.isConnected).toBe(true);
    expect(replacement.parentElement).not.toBe(parking);
  });

  it('only exposes page comments while a WebView generation exists', () => {
    browserState = makeBrowserState({ webview: null });
    const view = render(renderBrowserTab('https://www.taptap.cn/'));

    expect(
      screen.queryByRole('button', { name: 'rightSidebar.browser.comment' }),
    ).toBeNull();

    const webview = {
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as WebviewTag;
    browserState = makeBrowserState({ webview });
    view.rerender(renderBrowserTab('https://www.taptap.cn/'));

    expect(
      screen.getByRole('button', { name: 'rightSidebar.browser.comment' }),
    ).toBeTruthy();
  });

  it('does not patch the old webview URL back over a user-entered navigation while loading', () => {
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.taptap.cn/', patchState));

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(browserNavigate).toHaveBeenCalledWith('https://www.google.com');
    expect(patchState).toHaveBeenCalledWith({
      url: 'https://www.google.com',
      title: '',
      favicon: null,
      isAudible: false,
    });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: true,
    });
    view.rerender(renderBrowserTab('https://www.google.com', patchState));

    expect(patchState).not.toHaveBeenCalledWith({ url: 'https://www.taptap.cn/' });
  });

  it('does not issue a second webview navigation after a URL-bar submit patches state', () => {
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.taptap.cn/', patchState));
    browserNavigate.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(browserNavigate).toHaveBeenCalledTimes(1);
    expect(browserNavigate).toHaveBeenCalledWith('https://www.google.com');

    view.rerender(renderBrowserTab('https://www.google.com', patchState));

    expect(browserNavigate).toHaveBeenCalledTimes(1);
  });

  it('does not reload when state syncs to an already-current canonical URL', () => {
    browserState = makeBrowserState({
      url: 'https://www.google.com/',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.google.com', patchState));
    browserNavigate.mockClear();

    view.rerender(renderBrowserTab('https://www.google.com/', patchState));

    expect(browserNavigate).not.toHaveBeenCalled();
  });

  it('keeps a persisted favicon while the new webview has not observed one yet', () => {
    browserState = makeBrowserState({ favicon: null });
    const patchState = vi.fn();

    render(renderBrowserTab(
      'https://www.taptap.cn/',
      patchState,
      true,
      { favicon: 'https://www.taptap.cn/favicon.ico' },
    ));

    expect(patchState).not.toHaveBeenCalledWith({ favicon: null });
  });

  it('clears a persisted favicon after the webview explicitly reports none', () => {
    browserState = makeBrowserState({ favicon: '' });
    const patchState = vi.fn();

    render(renderBrowserTab(
      'https://www.taptap.cn/',
      patchState,
      true,
      { favicon: 'https://www.taptap.cn/favicon.ico' },
    ));

    expect(patchState).toHaveBeenCalledWith({ favicon: null });
  });

  it('does not run browser shortcuts while an editable target has focus', () => {
    const reload = vi.fn();
    const goBack = vi.fn();
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      canGoBack: true,
      reload,
      goBack,
    });
    render(renderBrowserTab('https://www.taptap.cn/'));

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'r', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'ArrowLeft', altKey: true });

    expect(reload).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();
  });

  it('does not patch slash-normalized old URLs back over a user-entered navigation', () => {
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.taptap.cn', patchState));

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    expect(browserNavigate).toHaveBeenCalledWith('https://www.google.com');

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: false,
    });
    view.rerender(renderBrowserTab('https://www.google.com', patchState));

    expect(patchState).not.toHaveBeenCalledWith({ url: 'https://www.taptap.cn/' });
  });

  it('only suppresses one stale URL report after user-entered navigation', () => {
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.taptap.cn/', patchState));

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn/' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: true,
    });
    view.rerender(renderBrowserTab('https://www.google.com', patchState));
    expect(patchState).not.toHaveBeenCalledWith({ url: 'https://www.taptap.cn/' });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://accounts.taptap.cn/login',
      isLoading: true,
    });
    view.rerender(renderBrowserTab('https://www.google.com', patchState));
    expect(patchState).toHaveBeenCalledWith({ url: 'https://accounts.taptap.cn/login' });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn/',
      isLoading: false,
    });
    view.rerender(renderBrowserTab('https://accounts.taptap.cn/login', patchState));
    expect(patchState).toHaveBeenCalledWith({ url: 'https://www.taptap.cn/' });
  });

  it('accepts canonical target URLs reported by the webview', () => {
    browserState = makeBrowserState({
      url: 'https://www.taptap.cn',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('https://www.taptap.cn', patchState));

    fireEvent.click(screen.getByRole('button', { name: 'https://www.taptap.cn' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://www.google.com/',
      isLoading: false,
    });
    view.rerender(renderBrowserTab('https://www.google.com', patchState));

    expect(patchState).toHaveBeenCalledWith({ url: 'https://www.google.com/' });
  });

  it('does not patch about:blank back over a user-entered navigation before loading flips true', () => {
    browserState = makeBrowserState({
      url: 'about:blank',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('about:blank', patchState));

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.newTab' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'baidu.com' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(browserNavigate).toHaveBeenCalledWith('https://baidu.com');
    expect(patchState).toHaveBeenCalledWith({
      url: 'https://baidu.com',
      title: '',
      favicon: null,
      isAudible: false,
    });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'about:blank',
      isLoading: false,
    });
    view.rerender(renderBrowserTab('https://baidu.com', patchState));

    expect(patchState).not.toHaveBeenCalledWith({ url: 'about:blank' });
  });

  it('accepts the real webview URL after it leaves the pre-navigation URL', () => {
    browserState = makeBrowserState({
      url: 'about:blank',
      isLoading: false,
    });
    const patchState = vi.fn();
    const view = render(renderBrowserTab('about:blank', patchState));

    fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.browser.newTab' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'google' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

    patchState.mockClear();
    browserState = makeBrowserState({
      url: 'https://www.google.com/search?q=111',
      isLoading: false,
    });
    view.rerender(renderBrowserTab('https://www.google.com', patchState));

    expect(patchState).toHaveBeenCalledWith({
      url: 'https://www.google.com/search?q=111',
    });
  });

  it('does not let initial about:blank overwrite a popup-created tab target before state navigation runs', () => {
    browserState = makeBrowserState({
      url: '',
      isLoading: false,
    });
    const patchState = vi.fn();

    render(renderBrowserTab('https://accounts.taptap.cn/login', patchState));

    expect(browserNavigate).toHaveBeenCalledWith('https://accounts.taptap.cn/login');
    expect(patchState).not.toHaveBeenCalledWith({ url: 'about:blank' });
  });

  it('never turns lagging persisted redirect state into a new navigation command', () => {
    const login = 'http://127.0.0.1:3360/auth/login';
    const authorize = 'http://127.0.0.1:3370/authorize?state=s';
    const callback = 'http://127.0.0.1:3360/auth/callback?code=c&state=s';
    const patchState = vi.fn();

    browserState = makeBrowserState({ url: login, isLoading: true });
    const view = render(renderBrowserTab(login, patchState));
    browserNavigate.mockClear();

    browserState = makeBrowserState({ url: authorize, isLoading: true });
    view.rerender(renderBrowserTab(login, patchState));
    browserState = makeBrowserState({ url: callback, isLoading: true });
    view.rerender(renderBrowserTab(authorize, patchState));
    browserState = makeBrowserState({ url: authorize, isLoading: true });
    view.rerender(renderBrowserTab(callback, patchState));

    expect(browserNavigate).not.toHaveBeenCalled();
  });

  it('opens a local HTML page through the file opener, preserving URL state', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    const openFileInBrowser = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        openExternal,
        openFileInBrowser,
        onRsbBrowserFocusUrlBar: vi.fn(() => vi.fn()),
        onRsbBrowserCommand: vi.fn(() => vi.fn()),
      },
    });
    browserState = makeBrowserState({
      url: 'file:///C:/repo/%E6%B5%8B%E8%AF%95%20page.html?mode=review#section',
    });
    render(
      renderBrowserTab(
        'file:///C:/repo/%E6%B5%8B%E8%AF%95%20page.html?mode=review#section',
      ),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.browser.openInSystemBrowser' }),
    );
    await Promise.resolve();

    expect(openFileInBrowser).toHaveBeenCalledWith(
      'file:///C:/repo/%E6%B5%8B%E8%AF%95%20page.html?mode=review#section',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('shows the file opener error when opening a local HTML page fails', async () => {
    const openFileInBrowser = vi.fn().mockRejectedValue(
      new Error('[BROWSER_FILE_NOT_FOUND] 文件不存在'),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        openExternal: vi.fn().mockResolvedValue({ success: true }),
        openFileInBrowser,
        onRsbBrowserFocusUrlBar: vi.fn(() => vi.fn()),
        onRsbBrowserCommand: vi.fn(() => vi.fn()),
      },
    });
    browserState = makeBrowserState({ url: 'file:///tmp/missing.html' });
    render(renderBrowserTab('file:///tmp/missing.html'));

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.browser.openInSystemBrowser' }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(toastMocks.error).toHaveBeenCalledWith(
      'chat.markdownRenderer.BROWSER_FILE_NOT_FOUND',
    );
  });

  it('keeps HTTP pages on the external URL opener', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    const openFileInBrowser = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
        openExternal,
        openFileInBrowser,
        onRsbBrowserFocusUrlBar: vi.fn(() => vi.fn()),
        onRsbBrowserCommand: vi.fn(() => vi.fn()),
      },
    });
    browserState = makeBrowserState({ url: 'https://example.com/path?q=1' });
    render(renderBrowserTab('https://example.com/path?q=1'));

    fireEvent.click(
      screen.getByRole('button', { name: 'rightSidebar.browser.openInSystemBrowser' }),
    );
    await Promise.resolve();

    expect(openExternal).toHaveBeenCalledWith('https://example.com/path?q=1');
    expect(openFileInBrowser).not.toHaveBeenCalled();
  });

  it('disables system-browser opening for remote local-file URLs', () => {
    browserState = makeBrowserState({ url: 'file:///remote/repo/index.html' });
    const ctx: TabKindHostContext = {
      tabId: 'tab-browser',
      sessionId: 'session-a',
      workdir: 'C:/repo',
      remoteHostId: 'ssh-host',
      patchState: vi.fn(),
      onVisibilityChange: vi.fn(),
      setCloseInterceptor: vi.fn(() => () => undefined),
    };
    render(
      createElement(BrowserTabBody, {
        active: true,
        ctx,
        state: {
          url: 'file:///remote/repo/index.html',
          title: '',
          favicon: null,
          isAudible: false,
        },
      }),
    );

    expect(
      (screen.getByRole('button', {
        name: 'rightSidebar.browser.openInSystemBrowser',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'rightSidebar.browser.copyLink' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('disables system-browser opening for device-link local-file URLs', async () => {
    browserState = makeBrowserState({ url: 'file:///remote/repo/index.html' });
    render(renderBrowserTab('file:///remote/repo/index.html', vi.fn(), true, {}, 'device-1'));

    expect(
      (screen.getByRole('button', {
        name: 'rightSidebar.browser.openInSystemBrowser',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('disables system-browser opening until device-link ownership is resolved', () => {
    browserState = makeBrowserState({ url: 'file:///remote/repo/index.html' });
    render(renderBrowserTab('file:///remote/repo/index.html', vi.fn(), true, {}, undefined));

    expect(
      (screen.getByRole('button', {
        name: 'rightSidebar.browser.openInSystemBrowser',
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it.each([
    ['remote device-link', 'device-1' as string | undefined],
    ['unresolved device-link', undefined],
  ])('disables local HTML auto reload for %s sessions', (_label, deviceLinkDeviceId) => {
    browserState = makeBrowserState({ url: 'file:///remote/repo/index.html' });
    render(renderBrowserTab('file:///remote/repo/index.html', vi.fn(), true, {}, deviceLinkDeviceId));

    expect(vi.mocked(useLocalHtmlAutoReload).mock.lastCall?.[0].enabled).toBe(false);
  });
});
