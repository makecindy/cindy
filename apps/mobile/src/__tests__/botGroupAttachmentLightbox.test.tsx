// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotGroupAttachment } from '@cindy/maker-shared/botGroupChat';
import type { ResolveRemoteMediaFn } from '@/session/remoteMedia';

// This suite exercises attachments; MCP App's native WebView is covered by mcpAppCard.test.tsx.
vi.mock('@/session/McpAppCard', () => ({ McpAppCard: () => null }));
// The shared message renderer also imports the site-video native surface.
vi.mock('react-native-webview', () => ({ WebView: () => null }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }));

// Group attachments open the real shared ImageLightbox here (#5875): the timeline strip, the payload
// conversion and the viewer are production code; only native surfaces and unrelated views are replaced.
const runtime = vi.hoisted(() => ({
  alerts: [] as unknown[][],
  imageEvents: new Map<string, { onLoad?: (event: unknown) => void; onError?: () => void }>(),
}));
const openBrowserAsync = vi.hoisted(() => vi.fn(async (_url: string) => ({})));
vi.mock('expo-web-browser', () => ({ openBrowserAsync }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-native', async () => {
  const React = await import('react');
  const view = ({ children, testID, accessibilityLabel, onPress }: any) => React.createElement('div', {
    'data-testid': testID, 'aria-label': accessibilityLabel,
    onClick: onPress ? (event: any) => onPress({ stopPropagation: () => event.stopPropagation() }) : undefined,
  }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} stopAnimation() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: view, ActivityIndicator: view,
    Image: Object.assign(view, { getSize() {} }), StatusBar: () => null,
    FlatList: ({ data, renderItem }: any) => React.createElement('div', null,
      data.map((item: unknown, index: number) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))),
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c,
      timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Platform: { OS: 'android', select: (s: any) => s.android ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {} },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {}, Linking: {},
    Alert: { alert: (...args: unknown[]) => runtime.alerts.push(args) },
    useWindowDimensions: () => ({ width: 393, height: 851, scale: 2.75, fontScale: 1 }),
  };
});
vi.mock('lucide-react-native', () => Object.fromEntries([
  'Mail', 'CalendarDays', 'Folder', 'ChartColumn', 'Info', 'Clock', 'MapPin', 'Coffee', 'Image', 'Users', 'Star',
  'Database', 'FileArchive', 'FileAudio', 'FileChartColumn', 'FileCode', 'FileImage', 'FileSpreadsheet', 'FileText', 'FileVideo',
  'ArrowLeftRight', 'ArrowUp', 'Bot', 'Check', 'ChevronDown', 'ChevronRight', 'ChevronUp', 'Circle', 'CircleAlert', 'CircleCheck',
  'CircleDashed', 'CircleStop', 'Copy', 'Ellipsis', 'ExternalLink', 'File', 'Ghost', 'Layers', 'ListTodo', 'LoaderCircle',
  'MessageSquarePlus', 'Pen', 'PencilLine', 'RefreshCw', 'Send', 'Share', 'Sparkles', 'Split', 'Timer', 'Trash2', 'TriangleAlert',
  'Undo2', 'X',
].map(name => [name, () => null])));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null, Path: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', async () => {
  const { createElement } = await import('react');
  return { Image: ({ source, onLoad, onError }: any) => {
    runtime.imageEvents.set(source.uri, { onLoad, onError });
    return createElement('img', { src: source.uri });
  } };
});
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }), useFocusEffect: vi.fn(),
  useNavigation: () => ({ isFocused: () => true, addListener: () => () => {}, setOptions: () => undefined }),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ status: 'offline', connectionEpoch: 0, getPresenceAvailability: () => false, invoke: vi.fn(), openLink: vi.fn() }),
  subscribeRemoteBotChanges: () => () => {},
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = new Proxy({}, { get: () => '#777777' });
  return { ...tokens, monoFont: 'monospace', useTheme: () => ({ colors, mode: 'light' }), useThemedStyles: (make: any) => make(colors) };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text, MAX_FONT_SIZE_MULTIPLIER: 2 }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/session/usePluginResultCard', () => ({ usePluginResultCard: () => ({}), useSessionPluginResource: () => ({ title: 'Art' }) }));
vi.mock('@/session/remoteMediaDiskCacheExpo', () => ({ downloadRemoteMediaShareTemp: vi.fn() }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/expandedBlockMemory', () => ({ useFoldableExpandedState: () => [false, vi.fn()] }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: () => null, showActionMenu: vi.fn(), usesNativePullDownMenu: () => false, usesSystemActionMenu: () => false }));
vi.mock('@/session/MobileComposerInputRow', () => ({ MobileComposerInputRow: () => null, MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0, MOBILE_COMPOSER_CONTROL_SIZE: 44 }));
vi.mock('@/session/NativeVideoPlayer', () => ({ NativeVideoPlayer: () => null }));
vi.mock('@/session/mermaidWebView', () => ({ MermaidDiagram: () => null }));
vi.mock('@/session/mathWebView', () => ({ MathFormulaWebView: () => null }));
vi.mock('@/session/mediaPlayerWebView', () => ({ RemoteMediaPlayerWebView: () => null }));
vi.mock('@/session/MarkdownBlockContent', () => ({ MarkdownBlockContent: () => null }));
vi.mock('@/session/MessageActionSheet', () => ({ MessageActionSheet: () => null }));
vi.mock('@/session/AuthorizationMessageCard', () => ({ AuthorizationMessageCard: () => null }));
vi.mock('@/session/CompanionMessageActions', () => ({ CompanionMessageActions: () => null }));
vi.mock('@/session/CompanionMessageCard', () => ({ CompanionMessageCard: () => null }));
vi.mock('@/session/PendingSendBubble', () => ({ PendingSendBubble: () => null }));
vi.mock('@/session/messageActions', async (original) => ({ ...await original<object>(), copyMessageText: vi.fn(), writeClipboardText: vi.fn() }));
vi.mock('@/platform/gestureHandler', async () => {
  const { View } = await import('react-native');
  const make = (): any => new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : () => make() });
  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: { Pan: make, Pinch: make, Tap: make, Exclusive: make, Simultaneous: make },
  };
});
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  const native = await import('react-native');
  return {
    default: { View: native.View, createAnimatedComponent: (component: unknown) => component },
    useSharedValue: (initial: number) => useRef({ value: initial }).current,
    useAnimatedStyle: (calculate: () => unknown) => ({ get current() { return calculate(); } }),
    runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
    cancelAnimation: () => undefined,
    withTiming: (target: number) => target,
    withSpring: (target: number) => target,
    withDecay: () => 0,
  };
});

import { BotGroupMessageAttachments } from '@/session/BotGroupMessageAttachments';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; });
beforeEach(() => { runtime.alerts = []; runtime.imageEvents.clear(); openBrowserAsync.mockClear(); });

// Placeholder for a short-lived authorized address; never a real signed URL.
const signedImageUrl = 'https://chat.example.invalid/media/group-picture.png?signature=placeholder';
const serverAttachment: BotGroupAttachment = { id: 'media-1', name: '1.png', category: 'file', mimeType: '', size: 0, url: null, path: null };

async function render(props: Partial<Parameters<typeof BotGroupMessageAttachments>[0]>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
    messageId: 'message-1', align: 'right', attachments: [serverAttachment],
    onResolveRemoteMedia: vi.fn<ResolveRemoteMediaFn>(), ...props,
  })));
  return host;
}

const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const loadFailedKey = 'message.lightbox.loadFailed';

describe('Chat Server group image attachments (#5875)', () => {
  it('shows an authorized HTTPS image in the real lightbox, re-authorizing on every tap', async () => {
    const resolveServerMedia = vi.fn(async (id: string): Promise<BotGroupAttachment> => ({
      id, name: '1.png', category: 'image', mimeType: 'image/png', size: 10, url: signedImageUrl, path: null,
    }));
    const container = await render({ resolveServerMedia });
    // The timeline keeps a file chip and never holds the signed address.
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain(signedImageUrl);

    await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledWith('media-1');
    const viewer = container.querySelector('[data-testid="message.imageLightbox"]');
    expect(viewer?.querySelector('img')?.getAttribute('src')).toBe(signedImageUrl);
    expect(container.textContent).not.toContain(loadFailedKey);
    act(() => runtime.imageEvents.get(signedImageUrl)!.onLoad?.({ source: { width: 1200, height: 900 } }));
    expect(container.textContent).not.toContain(loadFailedKey);

    await click(container.querySelector('[data-testid="message.imageLightboxCloseButton"]'));
    expect(container.querySelector('[data-testid="message.imageLightbox"]')).toBeNull();
    expect(container.innerHTML).not.toContain(signedImageUrl);

    await click(container.querySelector('[data-testid="message.filePreviewButton"]'));
    expect(resolveServerMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="message.imageLightbox"] img')?.getAttribute('src')).toBe(signedImageUrl);
  });

  it('opens a non-image server file through its short-lived download address, not the viewer', async () => {
    const fileUrl = 'https://chat.example.invalid/media/report.pdf?signature=placeholder';
    const resolveServerMedia = vi.fn(async (id: string): Promise<BotGroupAttachment> => ({
      id, name: 'report.pdf', category: 'file', mimeType: 'application/pdf', size: 10, url: fileUrl, path: null,
    }));
    const container = await render({ resolveServerMedia, attachments: [{ ...serverAttachment, name: 'report.pdf' }] });
    await click(container.querySelector('[data-testid^="message.filePreviewButton"]'));
    expect(openBrowserAsync).toHaveBeenCalledWith(fileUrl);
    expect(container.querySelector('[data-testid="message.imageLightbox"]')).toBeNull();
  });
});

describe('computer-hosted group image attachments', () => {
  it.each(['cindy-media://blobs/aa11bb22.png', 'xdt-image://cache/group-picture.png'])(
    'still fetches %s from the computer for the real lightbox',
    async (mediaUrl) => {
      const originalUrl = 'file:///cache/group-picture-original.png';
      const resolveMedia = vi.fn<ResolveRemoteMediaFn>(async (media) => ({
        url: media.thumbnail ? 'https://example.invalid/thumbnail.png' : originalUrl,
        previewable: true, mimeType: 'image/png', ossKey: 'group-picture', size: 10, expiresAt: '',
      }));
      const container = await render({
        onResolveRemoteMedia: resolveMedia,
        attachments: [{ id: 'local', name: 'group-picture.png', category: 'image', mimeType: 'image/png', size: 10, url: mediaUrl, path: null }],
      });
      await click(container.querySelector('[data-testid="message.mediaPreviewButton"]'));
      expect(resolveMedia).toHaveBeenCalledWith(expect.objectContaining({ url: mediaUrl, previewable: false }), expect.anything());
      expect(resolveMedia).toHaveBeenCalledWith(expect.not.objectContaining({ thumbnail: true }), expect.anything());
      const viewer = container.querySelector('[data-testid="message.imageLightbox"]');
      expect(viewer?.querySelector(`img[src="${originalUrl}"]`)).not.toBeNull();
      expect(container.textContent).not.toContain(loadFailedKey);
    },
  );
});
