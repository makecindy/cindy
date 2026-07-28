// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UseBrowserWebviewResult } from '../../../hooks/useBrowserWebview';
import type { TabKindHostContext } from '../../../types';
import { BrowserTabBody } from '../BrowserTabBody';

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

vi.mock('../../../hooks/useBrowserWebview', () => ({
  useBrowserWebview: () => browserState,
}));

vi.mock('../../../lib/browserWebviewPool', () => ({
  browserWebviewPool: {
    release: vi.fn(),
    // BrowserTabBody 还会调用 useBrowserComment；该 hook 经 peek 获取 webview
    // 并监听 ipc-message。导航测试没有真 webview，wrapper 仅用于验证 layout
    // cleanup 的 Pool 代际归属。
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
): ReactElement {
  const ctx: TabKindHostContext = {
    tabId: 'tab-browser',
    sessionId: 'session-a',
    workdir: 'C:/repo',
    remoteHostId: null,
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
    },
  });
}

describe('BrowserTabBody navigation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'win32',
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
});
