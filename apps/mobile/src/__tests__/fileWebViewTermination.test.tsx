// @vitest-environment jsdom
import { act, createElement } from 'react';
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
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: unknown }) => children,
  StyleSheet: { create: (value: unknown) => value },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import('react');
  return { WebView: forwardRef((props: Record<string, (...args: any[]) => void>, ref) => {
    state.props = props;
    useImperativeHandle(ref, () => ({ injectJavaScript() {} }));
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
