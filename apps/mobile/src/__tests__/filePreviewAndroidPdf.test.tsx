// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Screen from '../../app/files/preview/[sessionId]';
import { storeCachedListing } from '@/session/fileBrowserCache';

// Integration: Android WebView cannot render PDFs. The real preview screen must
// show the export/share page instead, fetch nothing until the user taps it, and
// then hand the original file name and PDF mime type to the system share sheet.
const state = vi.hoisted(() => ({
  scope: '',
  listDir: vi.fn(),
  exportFile: vi.fn(),
  shareTemp: vi.fn(),
  shareAsync: vi.fn(),
  pager: null as any,
  params: { sessionId: 'task', deviceId: 'device', relPath: 'docs/report.pdf' },
}));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children);
  const Pressable = ({ children, onPress, testID }: { children?: ReactNode; onPress?: () => void; testID?: string }) =>
    createElement('button', { 'data-testid': testID, onClick: onPress }, children);
  return {
    View, Text: View, Pressable, ActivityIndicator: () => null, Alert: {}, Platform: { OS: 'android' },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    FlatList: (props: { data: unknown[]; renderItem: (row: { item: unknown; index: number }) => ReactNode }) => {
      state.pager = props;
      return createElement('div', null, props.data.map((item, index) => createElement('div', { key: index }, props.renderItem({ item, index }))));
    },
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
vi.mock('expo-sharing', () => ({ shareAsync: state.shareAsync }));
vi.mock('react-native-webview', () => ({ WebView: () => { throw new Error('Android PDF page must not mount a WebView'); } }));
vi.mock('@/debug/mobileDebugLog', () => ({ mobileDebugLog: () => {} }));
vi.mock('@/session/remoteAbsFileFetch', () => ({}));
vi.mock('@/session/pdfPreviewSource', () => ({
  preparePdfPreviewSource: () => { throw new Error('Android PDF page must not prepare an inline source'); },
}));
vi.mock('@/session/fileBrowserExport', () => ({ exportRemoteFileToUrl: state.exportFile }));
vi.mock('@/session/FileTransferBusyNotice', () => ({ FileTransferBusyNotice: () => null }));
vi.mock('@/session/HtmlFileReader', () => ({}));
vi.mock('@/session/HtmlPreviewLoading', () => ({}));
vi.mock('@/session/HtmlBrowserChrome', () => ({ HtmlBrowserChrome: () => null }));
vi.mock('@/session/HtmlWebsiteBrowser', () => ({}));
vi.mock('@/session/mobileHtmlPreview', () => ({}));
vi.mock('@/session/useHtmlSnapshot', () => ({}));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: () => null }));
vi.mock('@/session/FileBrowserSegmentedControl', () => ({}));
vi.mock('@/session/MarkdownFileReader', () => ({}));
vi.mock('@/session/mediaPlayerWebView', () => ({}));
vi.mock('@/session/NativeVideoPlayer', () => ({}));
vi.mock('@/session/fileThumbnails', () => ({ useFileThumbnail: () => null }));
vi.mock('@/session/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: state.shareTemp }));

const entries = [{ name: 'report.pdf', relPath: 'docs/report.pdf', type: 'file' as const, size: 12200, mtimeMs: 7 }];
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 0; });
  state.scope += 'next';
  state.listDir.mockImplementation(() => new Promise(() => {}));
  state.exportFile.mockReset().mockResolvedValue('https://oss.example.invalid/report.pdf');
  state.shareTemp.mockReset().mockResolvedValue('file:///cache/share/x/report.pdf');
  state.shareAsync.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  root = createRoot(host);
  storeCachedListing(state.scope, '/repo', 'docs', entries);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

describe('Android PDF preview', () => {
  it('shows the export/share page without fetching, then shares the original PDF on tap', async () => {
    await act(async () => { root.render(<Screen />); });

    expect(host.querySelector('[data-testid="filePreview.unsupported"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="filePreview.pdfLoading"]')).toBeNull();
    expect(host.textContent).toContain("PDFs can't be previewed inside Cindy on Android yet.");
    expect(state.exportFile).not.toHaveBeenCalled();
    // No WebView owns horizontal drags on Android, so the pager keeps swiping to neighbours.
    expect(state.pager.scrollEnabled).toBe(true);

    const share = host.querySelector<HTMLButtonElement>('[data-testid="filePreview.unsupportedDownload"]');
    expect(share).not.toBeNull();
    await act(async () => { share!.click(); });

    expect(state.exportFile).toHaveBeenCalledOnce();
    expect(state.exportFile.mock.calls[0]?.slice(1)).toEqual(['/repo', 'docs/report.pdf', 7]);
    expect(state.shareTemp).toHaveBeenCalledWith(
      'https://oss.example.invalid/report.pdf', 'application/pdf', 'report.pdf', expect.anything(),
    );
    expect(state.shareAsync).toHaveBeenCalledExactlyOnceWith('file:///cache/share/x/report.pdf', { mimeType: 'application/pdf' });
  });
});
