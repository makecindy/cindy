// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import type { WebView } from 'react-native-webview';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PeerFileTransport } from '@/device-link/peerFileTransport';
import { DirectLinkTransport } from '@/device-link/DirectLinkTransport';
import { createDirectRuntimeBridge } from '@cindy/device-link';
import { HtmlSnapshotReader } from '@/session/HtmlFileReader';
import type { MobileHtmlPreview } from '@/session/mobileHtmlPreview';
import type { HtmlPreviewProgress, PrepareMobileHtmlPreview } from '@/session/mobileHtmlPreview';
import { useHtmlSnapshot } from '@/session/useHtmlSnapshot';
import { HtmlPreviewLoading } from '@/session/HtmlPreviewLoading';

const state = vi.hoisted(() => ({
  props: {} as Record<string, (...args: any[]) => void>,
  mounts: 0,
  unregister: vi.fn(),
  unregisterInvoke: vi.fn(),
  unregisterUpload: vi.fn(),
  unregisterReset: vi.fn(),
  install: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  inject: vi.fn(),
  appStateListeners: new Set<(value: string) => void>(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children }: { children: unknown }) => children,
  ActivityIndicator: () => null,
  StyleSheet: { create: (value: unknown) => value },
  AppState: { currentState: 'active', addEventListener: (_event: string, listener: (value: string) => void) => {
    state.appStateListeners.add(listener);
    return { remove() { state.appStateListeners.delete(listener); } };
  } },
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { surfaceElevated: '#FFFFFC' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children: unknown }) => children }));
vi.mock('react-i18next', async (original) => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
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
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ connectionEpoch: 1, status: 'online', invoke: vi.fn() }) }));
vi.mock('@/config/env', () => ({ DEVICE_LINK_API_BASE_URL: 'https://example.test', getActiveMobileSessionRealm: () => 'global' }));
vi.mock('@/device-link/peerFileRegistry', () => ({
  installPeerFileDownload: (...args: unknown[]) => { state.install(...args); return state.unregister; },
  installPeerInvoke: () => state.unregisterInvoke,
  installPeerUpload: () => state.unregisterUpload,
  installPeerUploadProbe: () => () => {},
  installPeerReset: () => state.unregisterReset,
  clearPeerMedia() {}, recordPeerMedia: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  state.mounts = 0; state.install.mockClear(); state.unregister.mockClear();
  state.unregisterInvoke.mockClear(); state.unregisterUpload.mockClear(); state.unregisterReset.mockClear();
  state.goBack.mockClear(); state.goForward.mockClear();
  state.inject.mockClear();
  vi.useRealTimers();
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
  expect(state.unregisterInvoke).toHaveBeenCalledTimes(1);
  expect(state.unregisterUpload).toHaveBeenCalledTimes(1);
  expect(state.unregisterReset).toHaveBeenCalledTimes(1);
  expect(state.mounts).toBe(2);
  act(() => { old[event](); old.onMessage({ nativeEvent: { data: '{"type":"ready"}' } }); });
  expect(state.mounts).toBe(2);
  expect(state.install).toHaveBeenCalledTimes(1);
  act(() => state.props.onMessage({ nativeEvent: { data: '{"type":"ready"}' } }));
  expect(state.install).toHaveBeenCalledTimes(2);
});

// Production bridge lifecycle, separate from file transfers: a backgrounded/crashed
// data-only WebView must immediately release paths and reject old document callbacks.
it.each(['onContentProcessDidTerminate', 'onRenderProcessGone'])('releases the LAN path after %s with bounded restarts', async event => {
  const bridge = createDirectRuntimeBridge(), closed = vi.fn();
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(DirectLinkTransport, { bridge, enabled: true, owner: 'one' })));
  const message = (type: string, extra = {}) => ({ nativeEvent: { data: JSON.stringify({ type, ...extra }) } });
  act(() => state.props.onMessage(message('ready')));
  bridge.runtime.create('one', { closed, open() {}, message() {}, drained() {} });
  const old = state.props;
  act(() => old[event]());
  expect(closed).toHaveBeenCalledOnce();
  expect(state.mounts).toBe(2);
  act(() => old.onMessage(message('ready')));
  expect(() => bridge.runtime.create('two', { closed, open() {}, message() {}, drained() {} })).toThrow('UNAVAILABLE');
  act(() => state.props.onMessage(message('ready')));
  bridge.runtime.create('two', { closed, open() {}, message() {}, drained() {} });
  act(() => state.props[event]());
  expect(closed).toHaveBeenCalledTimes(2);
  expect(state.mounts).toBe(2);
  expect(() => bridge.runtime.create('three', { closed, open() {}, message() {}, drained() {} })).toThrow('UNAVAILABLE');
});

it('does not accept LAN bridge callbacks across backgrounding, owner changes or unmount', () => {
  const bridge = createDirectRuntimeBridge(), closed = vi.fn();
  const events = { closed, open() {}, message() {}, drained() {} };
  const ready = { nativeEvent: { data: '{"type":"ready"}' } };
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(DirectLinkTransport, { bridge, enabled: true, owner: 'one' })));
  act(() => state.props.onMessage(ready));
  bridge.runtime.create('one', events);
  const old = state.props;
  act(() => { for (const fn of state.appStateListeners) fn('background'); });
  expect(closed).toHaveBeenCalledOnce();
  act(() => { for (const fn of state.appStateListeners) fn('active'); });
  act(() => old.onMessage(ready));
  expect(() => bridge.runtime.create('two', events)).toThrow('UNAVAILABLE');
  act(() => state.props.onMessage(ready));
  bridge.runtime.create('two', events);
  const previousOwner = state.props;
  act(() => root!.render(createElement(DirectLinkTransport, { bridge, enabled: true, owner: 'two' })));
  expect(closed).toHaveBeenCalledTimes(2);
  act(() => previousOwner.onMessage(ready));
  expect(() => bridge.runtime.create('three', events)).toThrow('UNAVAILABLE');
  act(() => state.props.onMessage(ready));
  const disposed = state.props;
  act(() => root!.unmount()); root = undefined;
  act(() => disposed.onMessage(ready));
  expect(() => bridge.runtime.create('three', events)).toThrow('UNAVAILABLE');
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

const hidden = () => [(state.props as Record<string, unknown>).style].flat(Infinity).some((style: any) => style?.opacity === 0);
// Unit regression: cached preparation and WebView loading used to mount two separate
// loading views. Keep one delayed indicator across both phases, with no flash on a fast open.
it('keeps one loading lifetime from preparation through the first document paint', () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  root = createRoot(container);
  const preview: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/a/', documents: ['/index.html'], close: async () => {} };
  const props = { onError() {}, loading: createElement(HtmlPreviewLoading) };
  act(() => root!.render(createElement(HtmlSnapshotReader, props)));
  expect(state.mounts).toBe(0);
  expect(container.textContent).toBe('');
  act(() => vi.advanceTimersByTime(150));
  act(() => root!.render(createElement(HtmlSnapshotReader, { ...props, preview })));
  expect(state.mounts).toBe(1);
  expect(container.textContent).toBe('');
  act(() => vi.advanceTimersByTime(50));
  expect(container.textContent).toContain('files.preview.fetchingHtmlResources');
  act(() => state.props.onLoadEnd());
  expect(container.textContent).toBe('');
  expect(hidden()).toBe(false);
});

// Unit regression: a duplicate foreground event must not discard a readable page.
// Actual background/foreground transitions must still release and recreate the native server.
it('keeps the page on duplicate active events and rebuilds only after suspension', async () => {
  root = createRoot(document.createElement('div'));
  const close = vi.fn().mockResolvedValue(undefined);
  const preview: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/a/', documents: [], close };
  const prepare = vi.fn().mockImplementation(async () => ({ ...preview }));
  let snapshot!: ReturnType<typeof useHtmlSnapshot>;
  function Harness() { snapshot = useHtmlSnapshot('/a.html', true, prepare); return null; }
  await act(async () => root!.render(createElement(Harness)));
  await act(async () => state.appStateListeners.forEach(listener => listener('active')));
  expect(snapshot.preview).toEqual(preview);
  expect(prepare).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(prepare.mock.lastCall?.[3]).toBe(true);
  await act(async () => snapshot.retry());
  expect(snapshot.preview).toEqual(preview);
  expect(prepare.mock.lastCall?.[3]).toBe(false);
  await act(async () => state.appStateListeners.forEach(listener => listener('background')));
  expect(snapshot.preview).toBeUndefined();
  expect(close).toHaveBeenCalledTimes(2);
  await act(async () => state.appStateListeners.forEach(listener => listener('active')));
  expect(snapshot.preview).toEqual(preview);
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(prepare.mock.lastCall?.[3]).toBe(true);
});

it('hides each snapshot until its first document loads, then reveals it', () => {
  const container = document.createElement('div');
  root = createRoot(container);
  const first: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/a/', documents: ['/index.html'], close: async () => {} };
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview: first, onError() {}, loading: 'loading-page' })));
  expect(hidden()).toBe(true);
  expect(container.textContent).toBe('loading-page');
  act(() => state.props.onLoadEnd());
  expect(hidden()).toBe(false);
  expect(container.textContent).toBe('');
  const next: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/b/', documents: ['/index.html'], close: async () => {} };
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview: next, onError() {} })));
  expect(hidden()).toBe(true);
  act(() => state.props.onLoadEnd());
  expect(hidden()).toBe(false);
});

// Unit: real hook + loading component, covering the formerly invisible transfer
// and late progress/error callbacks after switching files. No native network needed.
it('shows known bytes and speed, hides unknown percentages, and ignores retired progress', async () => {
  const container = document.createElement('div');
  root = createRoot(container);
  const observers: Array<(progress: HtmlPreviewProgress) => void> = [];
  const prepare: PrepareMobileHtmlPreview = async (_path, _signal, onProgress) => {
    observers.push(onProgress!);
    return { url: 'http://127.0.0.1:1234/preview', documents: [], close: async () => {} };
  };
  function Harness({ path, enabled = true }: { path: string; enabled?: boolean }) {
    const snapshot = useHtmlSnapshot(path, enabled, prepare);
    return createElement(HtmlPreviewLoading, { progress: snapshot.progress });
  }
  await act(async () => root!.render(createElement(Harness, { path: '/a.html' })));
  act(() => observers[0]({ name: 'a.html', loaded: 512, total: 1024, bytesPerSecond: 1024 }));
  expect(container.textContent).toContain('a.html50% · 1.0 KB/s');
  act(() => observers[0]({ name: 'a.html', loaded: 0, total: 0, bytesPerSecond: null }));
  expect(container.textContent).not.toMatch(/%|\/s/);
  await act(async () => root!.render(createElement(Harness, { path: '/b.html' })));
  act(() => observers[0]({ name: 'a.html', loaded: 1024, total: 1024, bytesPerSecond: 1024 }));
  expect(container.textContent).not.toContain('a.html');
  act(() => observers[1]({ name: 'b.html', loaded: 1, total: 4, bytesPerSecond: null }));
  expect(container.textContent).toContain('b.html25%');
  await act(async () => root!.render(createElement(Harness, { path: '/b.html', enabled: false })));
  act(() => observers[1]({ name: 'b.html', loaded: 4, total: 4, bytesPerSecond: 1 }));
  expect(container.textContent).not.toContain('b.html');
});

it('ignores late failure events from a replaced preview', () => {
  root = createRoot(document.createElement('div'));
  const onError = vi.fn();
  const preview: MobileHtmlPreview = { url: 'http://127.0.0.1:1234/first', documents: [], close: async () => {} };
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview, onError })));
  const old = state.props;
  act(() => root!.render(createElement(HtmlSnapshotReader, { preview: { ...preview, url: 'http://127.0.0.1:4321/next' }, onError })));
  act(() => old.onError({ nativeEvent: { code: -1001 } }));
  expect(onError).not.toHaveBeenCalled();
  act(() => state.props.onError({ nativeEvent: { code: -1001 } }));
  expect(onError).toHaveBeenCalledOnce();
});

// Unit regression for PR #6323: real hook + reader navigation followed by a delayed
// update must preserve the current inner page. Existing update cases had no navigation.
// Minimal input: cached entry -> sibling document -> background update resolves.
it.each(['sibling', 'entry', 'returned'] as const)('applies background updates only at the entry document (%s)', async (destination) => {
  root = createRoot(document.createElement('div'));
  let finishCheck!: (preview: MobileHtmlPreview) => void;
  const initial: MobileHtmlPreview = {
    url: 'http://127.0.0.1:1234/__cindy/token', documents: ['/report%20one.html', '/detail.html'],
    close: vi.fn().mockResolvedValue(undefined),
    updated: new Promise(resolve => { finishCheck = resolve; }),
  };
  const next = { ...initial, url: 'http://127.0.0.1:4321/__cindy/fresh', updated: undefined };
  const prepare = vi.fn().mockResolvedValue(initial);
  let snapshot!: ReturnType<typeof useHtmlSnapshot>;
  function Harness() {
    snapshot = useHtmlSnapshot('/report one.html', true, prepare);
    return createElement(HtmlSnapshotReader, {
      preview: snapshot.preview, onError() {}, onNavigationStateChange: snapshot.onNavigationStateChange,
    });
  }
  await act(async () => root!.render(createElement(Harness)));
  const navigate = (path: string) => act(() => state.props.onNavigationStateChange({ url: `http://127.0.0.1:1234/${path}` }));
  navigate(destination === 'entry' ? 'report%20one.html#details' : 'detail.html');
  if (destination === 'returned') navigate('report%20one.html');
  await act(async () => finishCheck(next));
  expect(snapshot.preview).toBe(destination === 'sibling' ? initial : next);
  expect(state.mounts).toBe(destination === 'sibling' ? 1 : 2);
  expect(initial.close).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledOnce();
  await act(async () => root!.unmount()); root = undefined;
  expect(initial.close).toHaveBeenCalledOnce();
});

// Unit: the real hook must retain usable content during automatic replacement and
// ignore late work after leaving. These timings were absent from manual-retry coverage.
it.each(['changed', 'same', 'failed', 'left'] as const)('replaces a stale snapshot at most once and preserves its owner (%s)', async (outcome) => {
  root = createRoot(document.createElement('div'));
  let finishCheck!: (preview: MobileHtmlPreview | null) => void;
  let failCheck!: (error: Error) => void;
  const initial: MobileHtmlPreview = {
    url: 'http://127.0.0.1:1234/old', documents: [], close: vi.fn().mockResolvedValue(undefined),
    updated: new Promise((resolve, reject) => { finishCheck = resolve; failCheck = reject; }),
  };
  const next: MobileHtmlPreview = {
    url: 'http://127.0.0.1:4321/new', documents: [], close: vi.fn().mockResolvedValue(undefined),
    updated: Promise.resolve(null),
  };
  const prepare = vi.fn().mockResolvedValue(initial);
  let snapshot!: ReturnType<typeof useHtmlSnapshot>;
  function Harness({ enabled = true }: { enabled?: boolean }) {
    snapshot = useHtmlSnapshot('/a.html', enabled, prepare); return null;
  }
  await act(async () => root!.render(createElement(Harness)));
  expect(snapshot.preview).toBe(initial);
  expect(initial.close).not.toHaveBeenCalled();
  if (outcome === 'left') await act(async () => root!.render(createElement(Harness, { enabled: false })));
  await act(async () => {
    if (outcome === 'failed') failCheck(new Error('offline'));
    else finishCheck(outcome === 'same' ? null : next);
  });
  expect(prepare).toHaveBeenCalledOnce();
  expect(snapshot.preview).toBe(outcome === 'changed' ? next : outcome === 'left' ? undefined : initial);
  expect(snapshot.error).toBeUndefined();
  if (outcome === 'left') expect(next.close).toHaveBeenCalledOnce();
  await act(async () => root!.render(createElement(Harness, { enabled: false })));
  expect(initial.close).toHaveBeenCalledOnce();
});
