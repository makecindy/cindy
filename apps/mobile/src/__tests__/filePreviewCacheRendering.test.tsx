// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Screen from '../../app/files/preview/[sessionId]';
import { storeCachedListing } from '@/session/fileBrowserCache';

// Integration: the real screen must start at the cached file's index and keep
// its position when the background directory request settles (reported on iOS).
const state = vi.hoisted(() => ({
  scope: '',
  listDir: vi.fn(),
  scroll: vi.fn(),
  pager: null as any,
  footer: null as any,
  params: { sessionId: 'task', deviceId: 'device', relPath: 'README.md' },
}));
vi.mock('react-native', async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react');
  const View = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    View, Text: View, Pressable: View, ActivityIndicator: () => null, Alert: {}, Platform: { OS: 'ios' },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    FlatList: forwardRef((props: any, ref) => {
      state.pager = props;
      useImperativeHandle(ref, () => ({ scrollToOffset: state.scroll }), []);
      return null;
    }),
  };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('react-native-safe-area-context', async () => ({
  SafeAreaView: (await import('react-native')).View,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => {
  const router = {};
  return { useLocalSearchParams: () => state.params, useRouter: () => router, useIsFocused: () => true, useFocusEffect: () => {} };
});
vi.mock('@/platform/chrome/SystemNavigationBack', () => ({ SystemNavigationBack: () => null, useSystemNavigationBack: () => false }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({ width: 390, insets: { left: 0, right: 0 } }) }));
vi.mock('@/session/usePreviewChromeFrame', () => ({ usePreviewChromeFrame: () => ({ top: 0, bottom: 0, left: 12, right: 12, contentTop: 48, sharedStatusRow: false }) }));
vi.mock('@/auth/AuthContext', () => { const auth = {}; return { useAuth: () => auth }; });
vi.mock('@/device-link/DeviceLinkContext', () => { const link = { openLink: async () => {} }; return { useDeviceLink: () => link }; });
vi.mock('@/device-link/unresponsiveDevicesStore', () => { const devices = new Set(); return { useUnresponsiveDevices: () => devices }; });
vi.mock('@/device-link/remoteRetry', () => ({ withTransientRemoteRetry: (read: () => unknown) => read() }));
vi.mock('@/device-link/useMobileMakerTransport', () => {
  const maker = { fileBrowser: { get cacheScope() { return state.scope; }, listDir: state.listDir } };
  return { useMobileMakerTransport: () => maker };
});
vi.mock('@/session/remoteSessionStore', () => {
  const sessions = [{ id: 'task', workingDir: '/repo' }];
  return { useRemoteSessions: () => sessions, remoteSessionStore: {} };
});
vi.mock('@/session/CindyMakeSessionGate', () => ({ CindyMakeSessionGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors: tokens.darkColors }), useThemedStyles: (make: any) => make(tokens.darkColors) };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, multiRemove: async () => {} } }));
vi.mock('lucide-react-native', () => Object.fromEntries(['ArrowDownToLine', 'Copy', 'Database', 'File', 'Info', 'MessageSquarePlus', 'Share'].map(key => [key, () => null])));
vi.mock('expo-clipboard', () => ({}));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('react-native-webview', () => ({ WebView: () => null }));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: () => {} }));
vi.mock('@/session/remoteAbsFileFetch', () => ({}));
vi.mock('@/session/pdfPreviewSource', () => ({}));
vi.mock('@/session/fileBrowserExport', () => ({}));
vi.mock('@/session/FileTransferBusyNotice', () => ({ FileTransferBusyNotice: () => null }));
vi.mock('@/session/HtmlFileReader', () => ({}));
vi.mock('@/session/HtmlPreviewLoading', () => ({}));
vi.mock('@/session/HtmlBrowserChrome', () => ({}));
vi.mock('@/session/HtmlWebsiteBrowser', () => ({}));
vi.mock('@/session/mobileHtmlPreview', () => ({}));
vi.mock('@/session/useHtmlSnapshot', () => ({}));
vi.mock('@/components/MobilePrimitives', () => ({}));
vi.mock('@/session/FileBrowserSegmentedControl', () => ({}));
vi.mock('@/session/MarkdownFileReader', () => ({}));
vi.mock('@/session/mediaPlayerWebView', () => ({}));
vi.mock('@/session/NativeVideoPlayer', () => ({}));
vi.mock('@/session/fileThumbnails', () => ({}));
vi.mock('@/session/ImageLightbox', () => ({}));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({}));

const entries = ['a.txt', 'b.txt', 'README.md', 's.txt', 't.txt', 'z.txt'].map(name => ({
  name, relPath: name, type: 'file' as const, size: 12200, mtimeMs: 1,
}));
let root: Root;
let host: HTMLDivElement;
let resolveListing: (value: unknown) => void;
let rejectListing: (error: Error) => void;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
  state.scope += 'next';
  state.scroll.mockClear();
  state.listDir.mockImplementation(() => new Promise((resolve, reject) => { resolveListing = resolve; rejectListing = reject; }));
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
async function open(cached = true) {
  if (cached) storeCachedListing(state.scope, '/repo', '', entries);
  await act(async () => { root.render(<Screen />); });
}

function expectVisiblePage(relPath: string, meta: string) {
  // Metadata now belongs to each page's floating chrome. Exercise the real
  // renderItem boundary without mounting the native readers in jsdom.
  type PageProps = {
    visible: boolean;
    active: boolean;
    item: { name: string; relPath: string };
    htmlBrowserActions: { meta: string };
  };
  const pages = state.pager.data.map((item: unknown, index: number) => {
    const row = state.pager.renderItem({ item, index }) as ReactElement<{ children: ReactElement<PageProps> }>;
    return row.props.children.props;
  }) as PageProps[];
  const visiblePages = pages.filter(page => page.visible);
  expect(visiblePages).toHaveLength(1);
  const [position, count] = meta.split(' · ')[0]!.split(' / ').map(Number);
  expect(state.footer.collection.index).toBe(position! - 1);
  expect(state.footer.collection.names).toHaveLength(count!);
  expect(state.footer.collection.names[position! - 1]).toBe(relPath);
  expect(visiblePages[0]).toMatchObject({
    active: true, item: { name: relPath, relPath }, htmlBrowserActions: { meta: meta.split(' · ')[1] ?? '' },
  });
}
describe('cached file preview presentation', () => {
  it('shows the cached index, count and size on the first render and does not reposition on unchanged refresh', async () => {
    await open();
    expectVisiblePage('README.md', '3 / 6 · 11.9 KB');
    expect(state.pager.initialScrollIndex).toBe(2);
    const selectedKey = state.pager.keyExtractor(state.pager.data[2]);
    state.scroll.mockClear();
    await act(async () => { resolveListing({ entries }); });
    expectVisiblePage('README.md', '3 / 6 · 11.9 KB');
    expect(state.pager.keyExtractor(state.pager.data[2])).toBe(selectedKey);
    expect(state.scroll).not.toHaveBeenCalled();
  });
  it('retains the selected neighbour and cached metadata when directory refresh fails', async () => {
    await open();
    act(() => state.pager.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 390 * 3 } } }));
    state.scroll.mockClear();
    await act(async () => { rejectListing(new Error('offline')); });
    expectVisiblePage('s.txt', '4 / 6 · 11.9 KB');
    expect(state.scroll).not.toHaveBeenCalled();
  });
  it('still opens without a listing and seeds subsequent opens from the successful background read', async () => {
    await open(false);
    expectVisiblePage('README.md', '1 / 1');
    state.scroll.mockClear();
    await act(async () => { resolveListing({ entries }); });
    expectVisiblePage('README.md', '3 / 6 · 11.9 KB');
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith({ animated: false, offset: 2 * 390 });
    act(() => root.unmount());
    root = createRoot(host);
    await open(false);
    expectVisiblePage('README.md', '3 / 6 · 11.9 KB');
  });
  it('keeps the file selected after a swipe when a directory refresh moves it to another index', async () => {
    await open();
    act(() => state.pager.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 390 * 3 } } }));
    expectVisiblePage('s.txt', '4 / 6 · 11.9 KB');
    const selectedKey = state.pager.keyExtractor(state.pager.data[3]);
    state.scroll.mockClear();
    await act(async () => { resolveListing({ entries: entries.slice(1) }); });
    expectVisiblePage('s.txt', '3 / 5 · 11.9 KB');
    expect(state.pager.data[state.pager.initialScrollIndex].relPath).toBe('s.txt');
    expect(state.pager.keyExtractor(state.pager.data[2])).toBe(selectedKey);
    expect(state.scroll).toHaveBeenCalledExactlyOnceWith({ animated: false, offset: 2 * 390 });
  });
});

vi.mock('expo-file-system', () => ({ File: class {} }));
vi.mock('@/session/TextDocumentPreview', () => ({ TextDocumentPreview: () => null }));
vi.mock('@/session/PdfDocumentPreview', () => ({ PdfDocumentPreview: () => null }));
vi.mock('@/session/ModelDocumentPreview', () => ({ ModelDocumentPreview: () => null }));
vi.mock('@/session/DiagramDocumentPreview', () => ({ DiagramDocumentPreview: () => null }));
vi.mock('@/session/PreviewChrome', async () => ({ PreviewFooter: (props: any) => { state.footer = props; return null; }, PreviewCollectionContext: (await import('react')).createContext(undefined) }));
