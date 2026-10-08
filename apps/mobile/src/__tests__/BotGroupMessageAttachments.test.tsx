// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolveRemoteMediaFn } from '@/session/remoteMedia';

// Keep the real group attachment, AttachmentStrip, MediaPreview and LegendList hooks.
// Only native surfaces and unrelated viewers are replaced for Node rendering.
const imageEvents = vi.hoisted(() => new Map<string, { onLoad: (event: unknown) => void; onError: () => void }>());
vi.mock('react-native', async () => {
  const React = await import('react');
  const view = ({ children, testID, accessibilityLabel, onPress }: any) => React.createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress }, children);
  class Value { constructor(public value: number) {} interpolate() { return 0; } setValue() {} stopAnimation() {} }
  return {
    View: view, Text: view, Pressable: view, ScrollView: view, Modal: () => null,
    Image: Object.assign(view, { getSize() {} }), ActivityIndicator: view,
    Animated: { Value, View: view, Text: view, createAnimatedComponent: (c: any) => c,
      timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Platform: { OS: 'ios', select: (s: any) => s.ios ?? s.default },
    StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, hairlineWidth: 1 },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {}, Alert: {}, Linking: {}, StatusBar: {},
    useWindowDimensions: () => ({ width: 402, height: 874, scale: 3, fontScale: 1 }),
  };
});
vi.mock('lucide-react-native', () => ({
  Database: () => null, FileArchive: () => null, FileAudio: () => null, FileChartColumn: () => null,
  FileCode: () => null, FileImage: () => null, FileSpreadsheet: () => null, FileText: () => null, FileVideo: () => null,
  ArrowLeftRight: () => null, ArrowUp: () => null, Bot: () => null, Check: () => null, ChevronDown: () => null, ChevronRight: () => null, ChevronUp: () => null, Circle: () => null, CircleAlert: () => null, CircleCheck: () => null, CircleDashed: () => null, CircleStop: () => null, Copy: () => null, Ellipsis: () => null, ExternalLink: () => null, File: () => null, Ghost: () => null, Layers: () => null, ListTodo: () => null, LoaderCircle: () => null, PencilLine: () => null, RefreshCw: () => null, Send: () => null, Share: () => null, Sparkles: () => null, Split: () => null, Timer: () => null, Trash2: () => null, TriangleAlert: () => null, Undo2: () => null, X: () => null,
}));
vi.mock('react-native-svg', () => ({ default: () => null, Circle: () => null }));
vi.mock('react-native-uitextview', () => ({ UITextView: () => null }));
vi.mock('expo-image', async () => {
  const { createElement } = await import('react');
  return { Image: ({ source, onLoad, onError, style }: any) => {
    imageEvents.set(source.uri, { onLoad, onError });
    const frame = Object.assign({}, ...[style].flat().filter(Boolean));
    return createElement('img', { src: source.uri, 'data-width': frame.width, 'data-height': frame.height });
  } };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: vi.fn(), useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({
  useDeviceLink: () => ({ status: 'offline', connectionEpoch: 0, getPresenceAvailability: () => false,
    invoke: vi.fn(), openLink: vi.fn() }),
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
vi.mock('@/session/ImageLightbox', async () => {
  const { createElement } = await import('react');
  return { ImageLightbox: ({ initialUrl }: { initialUrl: string }) => createElement('div', { 'data-testid': 'lightbox', 'data-url': initialUrl }) };
});
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

import { BotGroupMessageAttachments } from '@/session/BotGroupMessageAttachments';
import { AttachmentStrip } from '@/session/MessageRenderer';
import { buildMessageContentLayout } from '@/session/messageContentLayout';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; });

const imageUrl = 'xdt-image://cache/group-picture.png';
const thumbnailUrl = 'https://example.invalid/group-thumbnail.png';
const resolveMedia = vi.fn<ResolveRemoteMediaFn>(async () => ({
  url: thumbnailUrl, previewable: true, mimeType: 'image/png',
  ossKey: 'thumbnail', size: 10, expiresAt: '',
}));

beforeEach(() => { resolveMedia.mockClear(); imageEvents.clear(); });

async function renderAttachment(messageId: string) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(BotGroupMessageAttachments, {
    messageId,
    attachments: [{ id: 'attachment', size: 10, path: null, category: 'image', name: 'group-picture.png', url: imageUrl, mimeType: 'image/png' }],
    onResolveRemoteMedia: resolveMedia,
  })));
  return host;
}

describe('group image attachments outside LegendList (#5278)', () => {
  it('renders the real image preview without a list provider and opens its gallery', async () => {
    const container = await renderAttachment('new-message');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
    expect(resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: imageUrl, thumbnail: true }), expect.anything(),
    );
    act(() => (container.querySelector('[data-testid="message.mediaPreviewButton"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="lightbox"]')?.getAttribute('data-url')).toBe(imageUrl);
  });

  it('keeps local thumbnail sizing state outside the list, including the nested image component', async () => {
    const uri = 'file:///group-local-thumbnail.png';
    const layout = buildMessageContentLayout({ screenWidth: 402 });
    host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root!.render(createElement(AttachmentStrip, {
      attachments: [{ kind: 'image', name: 'local.png', uri: imageUrl, previewable: false }],
      messageKey: 'local-message', clientId: 'local-message', align: 'right', layout,
      usePreviewState: useState, onResolveRemoteMedia: resolveMedia,
      getImagePreview: () => ({ attachmentId: 'local', name: 'local.png', sourceRef: imageUrl, uri }),
    })));
    expect(host.querySelector('img')?.getAttribute('src')).toBe(uri);
    act(() => imageEvents.get(uri)!.onLoad({ source: { width: 100, height: 50 } }));
    expect(host.querySelector('img')?.getAttribute('data-width')).toBe('100');
    expect(host.querySelector('img')?.getAttribute('data-height')).toBe('50');
    await act(async () => imageEvents.get(uri)!.onError());
    expect(host.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
  });

  it('retries a failed remote thumbnail once, then shows the fallback and keeps the gallery action', async () => {
    const container = await renderAttachment('failed-thumbnail-message');
    await act(async () => imageEvents.get(thumbnailUrl)!.onError());
    expect(resolveMedia).toHaveBeenCalledTimes(2);
    expect(resolveMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: imageUrl, thumbnail: true }),
      expect.objectContaining({ forceRefresh: true }),
    );
    await act(async () => imageEvents.get(thumbnailUrl)!.onError());
    expect(resolveMedia).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="message.mediaThumbFallback"]')).not.toBeNull();
    act(() => (container.querySelector('[data-testid="message.mediaPreviewButton"]') as HTMLElement).click());
    expect(container.querySelector('[data-testid="lightbox"]')?.getAttribute('data-url')).toBe(imageUrl);
  });

  it('can reopen a group whose loaded history already contains an image', async () => {
    await renderAttachment('historical-message');
    act(() => root!.unmount());
    root = undefined;
    host!.remove();
    const reopened = await renderAttachment('historical-message');
    expect(reopened.querySelector('img')?.getAttribute('src')).toBe(thumbnailUrl);
  });
});
