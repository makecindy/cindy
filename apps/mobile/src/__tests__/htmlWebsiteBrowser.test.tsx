// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HtmlWebsiteBrowser } from '@/session/HtmlWebsiteBrowser';

const state = vi.hoisted(() => ({ chrome: {} as any, web: null as any, inject: vi.fn(), back: vi.fn(), reload: vi.fn(), alert: vi.fn() }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => children, ActivityIndicator: () => null,
  Platform: { OS: 'ios' }, Alert: { alert: state.alert }, Share: { share: vi.fn(async () => {}) },
  StyleSheet: { create: (value: unknown) => value, absoluteFill: {} },
}));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { WebView: forwardRef((props: any, ref) => {
    state.web = props;
    useImperativeHandle(ref, () => ({ injectJavaScript: state.inject, goBack: state.back, reload: state.reload }));
    return null;
  }) };
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('@/session/HtmlBrowserChrome', () => ({ HtmlBrowserChrome: (props: any) => { state.chrome = props; return null; } }));
vi.mock('@/session/useHtmlBrowserViewport', () => ({ useHtmlBrowserViewport: (insets: unknown) => ({ viewRef: { current: null }, measure() {}, script: 'true;', obscuredContentInsets: insets }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const onReturn = vi.fn();
function mount(snapshotClosed: Promise<void>) {
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(HtmlWebsiteBrowser, {
    visit: { url: 'https://example.com/', snapshotClosed }, insets: { top: 110, bottom: 82, left: 0, right: 0 },
    chrome: { top: 62, bottom: 34, left: 12, right: 12, onClose() {} }, onReturn,
  })));
}
afterEach(() => { act(() => root?.unmount()); root = undefined; state.web = null; vi.clearAllMocks(); });
it('waits for the file server to close before mounting a separate capability-free WebView', async () => {
  let close: () => void = () => {};
  mount(new Promise<void>(resolve => { close = resolve; }));
  expect(state.web).toBeNull();
  await act(async () => close());
  expect(state.web.source).toEqual({ uri: 'https://example.com/' });
  expect(state.web).toMatchObject({ incognito: true, allowFileAccess: false, setSupportMultipleWindows: false, mediaCapturePermissionGrantType: 'deny' });
  expect(state.web.onMessage).toBeUndefined();
  expect(state.web.contentInset).toEqual({ top: 110, bottom: 82, left: 0, right: 0 });
  expect(state.web.contentInset).toEqual(state.web.obscuredContentInsets);
  expect(state.web.onShouldStartLoadWithRequest({ url: 'tel:123' })).toBe(false);
});
it('edits the current website and preserves native back/reload semantics', async () => {
  mount(Promise.resolve()); await act(async () => {});
  act(() => state.web.onNavigationStateChange({ url: 'https://example.com/next', canGoBack: true, loading: false }));
  expect(state.chrome.address).toBe('https://example.com/next');
  expect(state.chrome.website).toBe(true);
  state.chrome.onBack(); expect(state.back).toHaveBeenCalledOnce();
  state.chrome.onReload(); expect(state.reload).toHaveBeenCalledOnce();
  expect(state.chrome.onNavigate('javascript:alert(1)')).toBe(false);
  state.inject.mockClear();
  act(() => { expect(state.chrome.onNavigate('example.org')).toBe(true); });
  expect(state.web.source).toEqual({ uri: 'https://example.org/' });
  expect(state.inject).not.toHaveBeenCalled();
  act(() => state.web.onNavigationStateChange({ url: 'https://example.com/next', loading: false }));
  expect(state.chrome.address).toBe('https://example.org/');
  state.chrome.onToggleSource(); expect(onReturn).toHaveBeenCalledOnce();
});
it('does not open a website after file closure fails', async () => {
  mount(Promise.reject(new Error('stop failed'))); await act(async () => {});
  expect(state.web).toBeNull();
  expect(state.chrome.loading).toBe(false);
  state.chrome.onBack(); expect(onReturn).toHaveBeenCalledOnce();
});

it('keeps an address entered while the file server is closing', async () => {
  let close!: () => void;
  mount(new Promise<void>(resolve => { close = resolve; }));
  act(() => state.chrome.onNavigate('example.org/new'));
  expect(state.web).toBeNull();
  await act(async () => close());
  expect(state.web.source.uri).toBe('https://example.org/new');
});
it('can navigate after the renderer terminates', async () => {
  mount(Promise.resolve()); await act(async () => {});
  act(() => state.web.onContentProcessDidTerminate());
  expect(state.chrome.loading).toBe(false);
  act(() => state.chrome.onNavigate('example.org/recover'));
  expect(state.web.source.uri).toBe('https://example.org/recover');
  expect(state.chrome.loading).toBe(true);
});
