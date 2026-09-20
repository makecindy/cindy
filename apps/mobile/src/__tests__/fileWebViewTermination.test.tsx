// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import type { WebView } from 'react-native-webview';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PeerFileTransport } from '@/device-link/peerFileTransport';
import { HtmlSnapshotReader } from '@/session/HtmlFileReader';
import type { MobileHtmlPreview } from '@/session/mobileHtmlPreview';

const state = vi.hoisted(() => ({
  props: {} as Record<string, (...args: any[]) => void>,
  mounts: 0,
  unregister: vi.fn(),
  install: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  inject: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children: unknown }) => children,
  StyleSheet: { create: (value: unknown) => value },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('@/session/useHtmlBrowserViewport', () => ({ useHtmlBrowserViewport: (insets: unknown) => ({ viewRef: { current: null }, measure() {}, script: '/* geometry only */ true;', obscuredContentInsets: insets }) }));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return { WebView: forwardRef((props: Record<string, (...args: any[]) => void>, ref) => {
    state.props = props;
    useImperativeHandle(ref, () => ({ injectJavaScript: state.inject, goBack: state.goBack, goForward: state.goForward }));
    useEffect(() => { state.mounts++; }, []);
    return null;
  }) };
});
vi.mock('expo-file-system', () => ({ Directory: class { exists = false; }, File: class {}, Paths: { cache: '/cache' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'id' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: 'a' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ connectionEpoch: 1, invoke: vi.fn() }) }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://example.test', getActiveMobileSessionRealm: () => 'global' }));
vi.mock('@/device-link/peerFileRegistry', () => ({
  installPeerFileDownload: (...args: unknown[]) => { state.install(...args); return state.unregister; },
  clearPeerMedia() {}, recordPeerMedia: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  state.mounts = 0; state.install.mockClear(); state.unregister.mockClear();
  state.goBack.mockClear(); state.goForward.mockClear();
  state.inject.mockClear();
});

it('installs geometry on each document and ignores scroll/load events from a disposed reader', () => {
  root = createRoot(document.createElement('div'));
  const preview: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/token/', documents: ['/index.html'], close: async () => {} };
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview, onError() {} })));
  expect(state.props.onMessage).toBeUndefined();
  const old = state.props;
  state.inject.mockClear();
  act(() => old.onLoadEnd());
  expect(state.inject).toHaveBeenLastCalledWith('/* geometry only */ true;');
  act(() => old.onScroll({ nativeEvent: { contentOffset: { x: 0, y: -122 } } }));
  expect(state.inject.mock.lastCall?.[0]).toContain('"y":-122');
  act(() => root!.unmount()); root = undefined;
  state.inject.mockClear();
  act(() => {
    old.onLoadEnd();
    old.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 250 } } });
  });
  expect(state.inject).not.toHaveBeenCalled();
});

it.each(['onContentProcessDidTerminate', 'onRenderProcessGone'])('recreates peer transport after %s and ignores the old renderer', (event) => {
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(PeerFileTransport)));
  act(() => state.props.onMessage({ nativeEvent: { data: '{"type":"ready"}' } }));
  expect(state.install).toHaveBeenCalledTimes(1);
  const old = state.props;
  act(() => old[event]());
  expect(state.unregister).toHaveBeenCalledTimes(1);
  expect(state.mounts).toBe(2);
  act(() => { old[event](); old.onMessage({ nativeEvent: { data: '{"type":"ready"}' } }); });
  expect(state.mounts).toBe(2);
  expect(state.install).toHaveBeenCalledTimes(1);
  act(() => state.props.onMessage({ nativeEvent: { data: '{"type":"ready"}' } }));
  expect(state.install).toHaveBeenCalledTimes(2);
});

it.each(['onContentProcessDidTerminate', 'onRenderProcessGone'])('routes snapshot %s to the existing error owner', (event) => {
  root = createRoot(document.createElement('div'));
  const onError = vi.fn();
  const preview = { url: 'http://127.0.0.1:1234/index.html', documents: [] } as unknown as MobileHtmlPreview;
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview, onError })));
  act(() => state.props[event]());
  expect(onError).toHaveBeenCalledOnce();
});


it.each([false, true])('routes entry HTTP errors to retry without failing on sibling resources (onDemand=%s)', (onDemand) => {
  root = createRoot(document.createElement('div'));
  const onError = vi.fn();
  const preview: MobileHtmlPreview = {
    url: 'http://127.0.0.1:1234/token/',
    documents: ['/report%20one.html'], onDemand, close: async () => {},
  };
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview, onError })));
  for (const path of ['image.png', 'style.css', 'other.js']) {
    act(() => state.props.onHttpError({ nativeEvent: { url: `http://127.0.0.1:1234/${path}`, statusCode: 404 } }));
  }
  expect(onError).not.toHaveBeenCalled();
  act(() => state.props.onHttpError({ nativeEvent: { url: 'http://127.0.0.1:1234/report%20one.html', statusCode: 502 } }));
  expect(onError).toHaveBeenCalledOnce();
});

it('exposes only the current WebView history and detaches controls when the reader leaves', () => {
  root = createRoot(document.createElement('div'));
  const webViewRef = createRef<WebView>();
  const onNavigationStateChange = vi.fn();
  const preview: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/token/', documents: ['/index.html'], close: async () => {} };
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview, onError() {}, webViewRef, onNavigationStateChange })));
  const old = state.props;
  const navigation = { url: 'http://127.0.0.1:1234/index.html#details', canGoBack: true, canGoForward: false, loading: false };
  act(() => state.props.onNavigationStateChange(navigation));
  expect(onNavigationStateChange).toHaveBeenLastCalledWith(preview, navigation);
  webViewRef.current?.goBack();
  webViewRef.current?.goForward();
  expect(state.goBack).toHaveBeenCalledOnce();
  expect(state.goForward).toHaveBeenCalledOnce();
  act(() => root!.unmount()); root = undefined;
  expect(webViewRef.current).toBeNull();
  act(() => old.onNavigationStateChange(navigation));
  expect(onNavigationStateChange).toHaveBeenCalledOnce();
});

it('starts a new native history for a refreshed snapshot and ignores navigation from the old snapshot', () => {
  root = createRoot(document.createElement('div'));
  const webViewRef = createRef<WebView>();
  const onNavigationStateChange = vi.fn();
  const initial: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/first/', documents: ['/index.html'], close: async () => {} };
  const refreshed = { ...initial, url: 'http://127.0.0.1:4567/second/' };
  const props = { onError() {}, webViewRef, onNavigationStateChange, viewportInsets: { top: 80, bottom: 64 } };
  act(() => root!.render(createElement(HtmlSnapshotReader, { ...props, preview: initial })));
  const old = state.props;
  const firstView = webViewRef.current;
  act(() => root!.render(createElement(HtmlSnapshotReader, { ...props, preview: refreshed })));
  expect(state.mounts).toBe(2);
  expect(webViewRef.current).not.toBe(firstView);
  act(() => old.onNavigationStateChange({ canGoBack: true }));
  expect(onNavigationStateChange).not.toHaveBeenCalled();
  const navigation = { canGoBack: false, canGoForward: false, loading: false };
  act(() => state.props.onNavigationStateChange(navigation));
  expect(onNavigationStateChange).toHaveBeenLastCalledWith(refreshed, navigation);
  expect(state.props.contentInset).toEqual({ top: 80, bottom: 64, left: 0, right: 0 });
  expect(state.props.contentInset).toEqual(state.props.obscuredContentInsets);
  expect(state.props.automaticallyAdjustContentInsets).toBe(false);
});
